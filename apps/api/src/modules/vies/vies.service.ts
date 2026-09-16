import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isGenericPartyName, parsePostalAddress } from './address-parser';

/**
 * Fase 4 — VIES (VAT Information Exchange System) via the official
 * European Commission REST API:
 *   POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *   { countryCode, vatNumber } → { valid, name, address, requestDate, ... }
 * (confirmed with curl on 2026-09-11: ES B06612386 → valid:true).
 *
 * Caching: 30 days, two layers — an in-process map (fast path, survives
 * until restart) and the Party row (`viesValidatedAt`/`viesValid`/
 * `viesName`/`viesAddress`) so the result outlives restarts and is visible
 * in the supplier file. The result feeds `classifyFiscalStatus` (a foreign
 * invoice is FISCAL only when its VAT is VIES-valid) and `vatRegime`.
 */
export interface ViesResult {
  countryCode: string;
  vatNumber: string;
  valid: boolean;
  name: string | null;
  address: string | null;
  checkedAt: Date;
  /** 'cache' when served from memory/DB without a network call. */
  source: 'vies' | 'cache' | 'error';
  error?: string;
}

export const VIES_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const EU_VAT_COUNTRIES = new Set([
  'AT','BE','BG','CY','CZ','DE','DK','EE','EL','ES','FI','FR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','XI',
]);

export function splitVat(raw: string): { countryCode: string; vatNumber: string } | null {
  const v = (raw ?? '').replace(/[\s.\-]/g, '').toUpperCase();
  const m = v.match(/^([A-Z]{2})([A-Z0-9+*]{2,13})$/);
  if (!m) return null;
  // VIES uses EL for Greece; documents print GR.
  const cc = m[1] === 'GR' ? 'EL' : m[1];
  if (!EU_VAT_COUNTRIES.has(cc)) return null;
  return { countryCode: cc, vatNumber: m[2] };
}

/**
 * Fase 4.1 — o NIF-IVA a consultar no VIES para uma entidade.
 *
 * Bug real apanhado no smoke: para fornecedores estrangeiros o prefixo
 * do país já está dentro de `nif` (`ESB09802059`), e colar-lhe o país à
 * frente produzia `ESESB09802059`. O `splitVat` partia isso em
 * cc=`ES` + número=`ESB09802059`, o VIES respondia "não existe", e
 * TODOS os fornecedores estrangeiros apareciam como inválidos — mais: o
 * valor corrompido ficava gravado em `vatNumber`. A Clima Hostelería
 * escapou por já ter `vatNumber` preenchido e não passar por aqui.
 */
export function resolvePartyVat(party: {
  vatNumber?: string | null;
  nif?: string | null;
  country?: string | null;
}): string | null {
  const clean = (v: string) => v.replace(/[\s.\-/]/g, '').toUpperCase();
  if (party.vatNumber) return clean(party.vatNumber);
  const nif = party.nif ? clean(party.nif) : '';
  if (!nif) return null;
  // Já traz prefixo de país comunitário → usa-se tal como está.
  const prefix = nif.slice(0, 2);
  if (/^[A-Z]{2}$/.test(prefix) && EU_VAT_COUNTRIES.has(prefix === 'GR' ? 'EL' : prefix)) {
    return nif;
  }
  // Só prefixamos com países que o VIES conhece — um "US"+número nunca
  // seria consultável e só serviria para gravar lixo em `vatNumber`.
  const country = party.country?.trim().toUpperCase();
  if (country && country !== 'PT' && EU_VAT_COUNTRIES.has(country === 'GR' ? 'EL' : country)) {
    return `${country}${nif}`;
  }
  if (/^\d{9}$/.test(nif)) return `PT${nif}`;
  return null;
}

@Injectable()
export class ViesService {
  private readonly logger = new Logger(ViesService.name);
  private readonly endpoint =
    process.env.VIES_URL?.trim() ||
    'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
  private readonly memory = new Map<string, ViesResult>();

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  /** Validate a country-prefixed VAT id with 30-day caching. Never throws. */
  async check(rawVat: string, opts?: { force?: boolean; tenantId?: string }): Promise<ViesResult | null> {
    const parts = splitVat(rawVat);
    if (!parts) return null;
    const key = `${parts.countryCode}${parts.vatNumber}`;
    const now = Date.now();

    if (!opts?.force) {
      const mem = this.memory.get(key);
      if (mem && now - mem.checkedAt.getTime() < VIES_CACHE_TTL_MS) {
        return { ...mem, source: 'cache' };
      }
      const fromDb = await this.readPartyCache(key, opts?.tenantId);
      if (fromDb) {
        this.memory.set(key, fromDb);
        return { ...fromDb, source: 'cache' };
      }
    }

    const result = await this.callVies(parts.countryCode, parts.vatNumber);
    if (result.source === 'vies') {
      this.memory.set(key, result);
      await this.writePartyCache(key, result, opts?.tenantId);
    }
    return result;
  }

  /** Convenience for the extraction pipeline: true only for a fresh/cached VALID answer. */
  async isValidated(rawVat: string, tenantId?: string): Promise<boolean> {
    const r = await this.check(rawVat, { tenantId });
    return !!r && r.valid && r.source !== 'error';
  }

  /** Validate the VAT stored on a Party and persist the answer + vatRegime. */
  async validateParty(tenantId: string, partyId: string, force = false) {
    if (!this.prisma) return null;
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: {
        id: true,
        vatNumber: true,
        nif: true,
        country: true,
        name: true,
        address: true,
        city: true,
        postalCode: true,
      },
    });
    if (!party) return null;
    const vat = resolvePartyVat(party);
    if (!vat) return { partyId, result: null, reason: 'no_vat_number' };
    const result = await this.check(vat, { force, tenantId });
    if (!result) return { partyId, result: null, reason: 'invalid_vat_syntax' };
    const cc = result.countryCode;
    const regime = cc === 'PT' ? 'PT' : EU_VAT_COUNTRIES.has(cc) ? 'UE_REVERSE_CHARGE' : 'EXTRA_UE';
    if (result.source !== 'error') {
      // Fase 4.2 (P1.1) — o VIES respondia e ninguém escrevia a
      // resposta na ficha: `viesName`/`viesAddress` ficavam gravados
      // como cache, mas `name`/`address`/`city`/`postalCode` — os
      // campos que a ficha realmente mostra — nunca eram tocados. O
      // IKEA ficava "Fornecedor por identificar" com tudo vazio ao
      // lado de um painel VIES que já tinha o nome e a morada certos.
      const nameIsGeneric = isGenericPartyName(party.name, party.nif, party.vatNumber);
      const parsedAddress = result.valid ? parsePostalAddress(result.address) : null;
      let fallbackName: string | null = null;
      if (result.valid && !result.name && nameIsGeneric && this.prisma?.document?.findFirst) {
        const linked = await this.prisma.document.findFirst({
          where: {
            OR: [
              { partyId },
              ...(party.nif ? [{ supplierNif: party.nif }] : []),
              ...(party.vatNumber ? [{ supplierNif: party.vatNumber }] : []),
            ],
            supplier: { not: null },
          },
          select: { supplier: true },
          orderBy: { createdAt: 'desc' },
        });
        if (linked?.supplier && !isGenericPartyName(linked.supplier)) {
          fallbackName = linked.supplier.trim().slice(0, 200);
        }
      }
      const finalName = result.name || fallbackName;

      await this.prisma.party.update({
        where: { id: partyId },
        data: {
          viesValidatedAt: result.checkedAt,
          viesValid: result.valid,
          viesName: result.name,
          viesAddress: result.address,
          ...(result.valid ? { vatRegime: regime as 'PT' | 'UE_REVERSE_CHARGE' | 'EXTRA_UE' } : {}),
          ...(party.vatNumber ? {} : { vatNumber: `${cc}${result.vatNumber}` }),
          // O nome oficial só substitui um nome genérico — nunca
          // sobrepõe um nome que o operador já confirmou ou corrigiu.
          ...(result.valid && finalName && nameIsGeneric ? { name: finalName } : {}),
          // A morada só preenche o que estiver vazio — nunca apaga
          // dados já corretos.
          ...(parsedAddress && !party.address && parsedAddress.address ? { address: parsedAddress.address } : {}),
          ...(parsedAddress && !party.city && parsedAddress.city ? { city: parsedAddress.city } : {}),
          ...(parsedAddress && !party.postalCode && parsedAddress.postalCode ? { postalCode: parsedAddress.postalCode } : {}),
          ...(result.valid && cc && ((party.country === 'PT' && cc !== 'PT') || !party.country) ? { country: cc } : {}),
        },
      });
    }
    return { partyId, result, reason: null };
  }

  private async callVies(countryCode: string, vatNumber: string): Promise<ViesResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ countryCode, vatNumber }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        this.logger.warn(`[vies] ${countryCode}${vatNumber} → HTTP ${res.status}`);
        return { countryCode, vatNumber, valid: false, name: null, address: null, checkedAt: new Date(), source: 'error', error: `http_${res.status}` };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const pick = (k: string) => {
        const v = body[k];
        return typeof v === 'string' && v.trim() && !/^[-–—\s/._*#]+$/.test(v.trim()) ? v.trim() : null;
      };
      // "MS_UNAVAILABLE"/"SERVICE_UNAVAILABLE" come back as userError with valid=false
      const userError = pick('userError');
      if (userError && userError !== 'VALID' && userError !== 'INVALID') {
        return { countryCode, vatNumber, valid: false, name: null, address: null, checkedAt: new Date(), source: 'error', error: userError };
      }
      return {
        countryCode,
        vatNumber,
        valid: body.valid === true,
        name: pick('name'),
        address: pick('address'),
        checkedAt: new Date(),
        source: 'vies',
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[vies] ${countryCode}${vatNumber} failed: ${msg}`);
      return { countryCode, vatNumber, valid: false, name: null, address: null, checkedAt: new Date(), source: 'error', error: msg.includes('abort') ? 'timeout' : 'transport' };
    }
  }

  private async readPartyCache(key: string, tenantId?: string): Promise<ViesResult | null> {
    if (!this.prisma) return null;
    try {
      const party = await this.prisma.party.findFirst({
        where: {
          ...(tenantId ? { tenantId } : {}),
          vatNumber: key,
          viesValidatedAt: { gte: new Date(Date.now() - VIES_CACHE_TTL_MS) },
          viesValid: { not: null },
        },
        select: { viesValidatedAt: true, viesValid: true, viesName: true, viesAddress: true },
        orderBy: { viesValidatedAt: 'desc' },
      });
      if (!party?.viesValidatedAt) return null;
      const parts = splitVat(key)!;
      return {
        countryCode: parts.countryCode,
        vatNumber: parts.vatNumber,
        valid: party.viesValid === true,
        name: party.viesName,
        address: party.viesAddress,
        checkedAt: party.viesValidatedAt,
        source: 'cache',
      };
    } catch {
      return null;
    }
  }

  private async writePartyCache(key: string, result: ViesResult, tenantId?: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.party.updateMany({
        where: { ...(tenantId ? { tenantId } : {}), vatNumber: key },
        data: {
          viesValidatedAt: result.checkedAt,
          viesValid: result.valid,
          viesName: result.name,
          viesAddress: result.address,
        },
      });
    } catch (err) {
      this.logger.debug(`[vies] party cache write skipped: ${(err as Error).message}`);
    }
  }
}
