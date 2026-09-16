import { Injectable, Logger, Optional } from '@nestjs/common';
import { AuditAction, DocumentStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  EnrichmentProviderFactory,
  type EnrichmentFields,
  type EnrichmentResult,
} from './providers/provider.factory';
import { NifLookupService } from '../nif-lookup/nif-lookup.service';
import { isGenericPartyName } from '../vies/address-parser';

/**
 * EnrichmentService — orchestrates the external-API enrichment flow.
 *
 * Lifecycle of `enrichParty(tenantId, partyId)`:
 *
 *   1. SELECT the Party row (id, nif, iban, country, enrichedAt,
 *      enrichedAt, enrichmentSource, enrichmentError, all the fields
 *      we'd potentially fill).
 *   2. Check 30-day TTL gate. If enrichedAt < 30d AND the cached
 *      source was `sabi-pt` / `vies`, return `{ source: 'cached' }`.
 *   3. Pick the provider via factory (country/iban → sabi-pt / vies /
 *      manual). Caller can force a specific provider with the
 *      optional `forceProvider` argument (UI/debug).
 *   4. Call the provider. Never throw — every provider is best-effort.
 *   5. Apply the **only-fill-nulls** rule: only write fields that are
 *      currently null on the Party row. This preserves manual overrides.
 *   6. UPDATE the Party row:
 *        - enrichedAt = now() if any field was filled
 *        - enrichmentSource = 'sabi-pt' | 'vies' | 'manual' on success
 *        - enrichmentError = null | reason string on failure
 *   7. Audit row: AuditAction.EDIT with metadata.subAction = 'party.enrich'
 *      and `fieldsPopulated`, `source`, `error` for forensics.
 *
 * Concurrency: an in-memory `Map<partyId, Promise>` deduplicates
 * concurrent calls so a UI double-click + a pipeline auto-trigger
 * don't both race the provider. The map key is `tenantId:partyId` so
 * two tenants can't collide.
 *
 * Scope note: this service DOES NOT manage the provider cache itself.
 * Each provider returns fresh data and the 30-day gate is a DB column.
 * That keeps the design testable and Redis-optional.
 */
@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);
  /** 30-day TTL gate. Aligned with the scout-report §5.4 decision. */
  private static readonly TTL_MS = 30 * 24 * 60 * 60 * 1000;
  /** Single-flight dedupe. Key: `${tenantId}:${partyId}`. */
  private readonly inFlight = new Map<string, Promise<EnrichmentOutcome>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly factory: EnrichmentProviderFactory,
    @Optional() private readonly nifLookup?: NifLookupService,
  ) {}

  // ============================================================ public API

  /**
   * Enrich a single Party. Public surface; controller routes here for
   * `POST /parties/:id/enrich`.
   */
  async enrichParty(
    tenantId: string,
    partyId: string,
    userId: string,
    options: {
      forceProvider?: 'sabi-pt' | 'vies' | 'nif-lookup' | 'invoices' | 'manual' | 'auto';
      skipCache?: boolean;
    } = {},
  ): Promise<EnrichmentOutcome> {
    const cacheKey = `${tenantId}:${partyId}`;
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      this.logger.debug(
        `[enrichParty] dedupe — returning in-flight promise for ${cacheKey}`,
      );
      return existing;
    }

    const promise = this.runEnrich(tenantId, partyId, userId, options).finally(
      () => {
        this.inFlight.delete(cacheKey);
      },
    );
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Read-only metadata for `GET /parties/:id/enrichment`. Returns the
   * three columns the UI badge needs without triggering an enrich.
   */
  async getMetadata(
    tenantId: string,
    partyId: string,
  ): Promise<{
    lastEnrichedAt: Date | null;
    source: string | null;
    error: string | null;
    provider: 'sabi-pt' | 'vies' | 'manual' | 'none';
  }> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: {
        nif: true,
        country: true,
        iban: true,
        enrichedAt: true,
        enrichmentSource: true,
        enrichmentError: true,
      },
    });
    if (!party) {
      return { lastEnrichedAt: null, source: null, error: null, provider: 'none' };
    }
    const provider = this.factory.pick(party.country, party.iban).name;
    return {
      lastEnrichedAt: party.enrichedAt,
      source: party.enrichmentSource,
      error: party.enrichmentError,
      provider,
    };
  }

  // ============================================================ internals

  /**
   * Pick provider, fetch, apply only-fill-nulls, write back, audit.
   */
  private async runEnrich(
    tenantId: string,
    partyId: string,
    userId: string,
    options: {
      forceProvider?: 'sabi-pt' | 'vies' | 'nif-lookup' | 'invoices' | 'manual' | 'auto';
      skipCache?: boolean;
    },
  ): Promise<EnrichmentOutcome> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: {
        id: true,
        // Fase 4.2 (P1.1) — precisamos do nome atual e do NIF-IVA para
        // decidir se o nome é genérico e pode ser substituído pelo
        // oficial do VIES/faturas.
        name: true,
        vatNumber: true,
        nif: true,
        country: true,
        iban: true,
        enrichedAt: true,
        email: true,
        phone: true,
        mobile: true,
        address: true,
        city: true,
        postalCode: true,
        website: true,
        industry: true,
      },
    });
    if (!party) {
      throw new Error(`Party ${partyId} not found in tenant ${tenantId}`);
    }

    // 30-day TTL gate (skip when caller forces a fresh run).
    if (
      !options.skipCache &&
      party.enrichedAt &&
      Date.now() - party.enrichedAt.getTime() < EnrichmentService.TTL_MS
    ) {
      this.logger.log(
        `[enrichParty] cache hit — party=${partyId} enriched ${Math.round(
          (Date.now() - party.enrichedAt.getTime()) / 86400_000,
        )}d ago`,
      );
      return {
        source: 'cached',
        fieldsPopulated: [],
        error: null,
        fetchedAt: party.enrichedAt,
      };
    }

    const provider = options.forceProvider
      ? this.providerByName(options.forceProvider)
      : this.factory.pick(party.country, party.iban);

    this.logger.log(
      `[enrichParty] tenant=${tenantId} party=${partyId} ` +
        `country=${party.country ?? 'null'} iban=${
          party.iban ? party.iban.slice(0, 4) + '***' : 'null'
        } provider=${provider.name}`,
    );

    let result: EnrichmentResult = await provider.fetch({
      nif: party.vatNumber || party.nif,
      country: party.country,
      iban: party.iban,
    });

    // Fallback 1: Se o provider falhou ou não retornou dados utilizáveis, e for NIF português, tenta NIF Lookup oficial
    if ((!result.ok || Object.keys(result.fields ?? {}).length === 0) && this.nifLookup && party.nif && (party.country === 'PT' || !party.country)) {
      try {
        const nifRes = await this.nifLookup.lookup(tenantId, userId, party.nif);
        if (nifRes.baseVerified || nifRes.address || nifRes.name) {
          const addressStr = nifRes.address ?? null;
          const postalCode = addressStr ? addressStr.match(/\b(\d{4}-\d{3})\b/)?.[1] ?? null : null;
          const city = addressStr ? this.guessCity(addressStr) : null;

          result = {
            ok: true,
            source: 'vies' as any, // nif-lookup ou vies oficial
            fields: {
              name: nifRes.name ?? null,
              address: addressStr,
              city,
              postalCode,
              country: 'PT',
            },
          };
        }
      } catch (err) {
        this.logger.warn(`[enrichParty] nifLookup fallback failed: ${(err as Error).message}`);
      }
    }

    // Fallback 2: Tentar VIES diretamente se ainda não tiver dados
    if (!result.ok && this.factory['vies'] && (party.vatNumber || party.nif) && (party.country || 'PT')) {
      try {
        const viesRes = await this.factory['vies'].fetch({
          nif: party.vatNumber || party.nif,
          country: party.country || 'PT',
          iban: party.iban,
        });
        if (viesRes.ok) {
          result = viesRes;
        }
      } catch (err) {
        this.logger.warn(`[enrichParty] vies fallback failed: ${(err as Error).message}`);
      }
    }

    // Enriquecimento complementar via melhores faturas extraídas desse fornecedor
    const combinedFields: EnrichmentFields = result.ok ? { ...result.fields } : {};
    if (combinedFields.address && /^[-–—\s/.]+$/.test(combinedFields.address.trim())) {
      delete combinedFields.address;
    }
    const invoiceFields = await this.extractFieldsFromInvoices(tenantId, partyId);
    for (const [key, val] of Object.entries(invoiceFields)) {
      if (!combinedFields[key as keyof EnrichmentFields] && val) {
        (combinedFields as any)[key] = val;
      }
    }

    const effectiveSource: any =
      result.ok ? result.source : Object.keys(invoiceFields).length > 0 ? 'invoices' : 'manual';

    // Fase 4.2 (P1.1) — um nome genérico ("Fornecedor por identificar",
    // vazio, ou o próprio NIF repetido) é substituído pelo nome oficial;
    // um nome que o operador já confirmou nunca é tocado. Isto ficava de
    // fora do "only-fill-nulls" (que só olha para campos NULOS — um nome
    // quase nunca é nulo, é genérico).
    const merged = this.applyOnlyFillNulls(party, combinedFields);
    if (
      combinedFields.name &&
      !isGenericPartyName(combinedFields.name) &&
      isGenericPartyName(party.name, party.nif, party.vatNumber)
    ) {
      merged.push('name');
    }
    if (merged.length === 0) {
      if (!result.ok) {
        await this.recordFailure(tenantId, partyId, userId, result.reason);
        return {
          source: 'manual',
          fieldsPopulated: [],
          error: result.reason,
          fetchedAt: new Date(),
        };
      }
      // Provider returned nothing we can use. Mark as 'no_data'
      await this.recordFailure(tenantId, partyId, userId, 'no_data');
      return {
        source: 'no_data',
        fieldsPopulated: [],
        error: null,
        fetchedAt: new Date(),
      };
    }

    await this.writeEnrichment(
      tenantId,
      partyId,
      userId,
      effectiveSource,
      merged,
      combinedFields,
    );
    return {
      source: effectiveSource,
      fieldsPopulated: merged,
      error: null,
      fetchedAt: new Date(),
    };
  }

  /**
   * Extrai dados complementares a partir das melhores faturas extraídas deste fornecedor.
   */
  private async extractFieldsFromInvoices(
    tenantId: string,
    partyId: string,
  ): Promise<EnrichmentFields> {
    if (!this.prisma?.document?.findMany) return {};
    const party = await this.prisma.party.findUnique({
      where: { id: partyId },
      select: { nif: true, vatNumber: true },
    });
    const conditions: Array<Record<string, unknown>> = [{ partyId }];
    if (party?.nif) conditions.push({ supplierNif: party.nif });
    if (party?.vatNumber) conditions.push({ supplierNif: party.vatNumber });

    const docs = await this.prisma.document.findMany({
      where: {
        tenantId,
        status: { not: DocumentStatus.REJEITADO },
        OR: conditions,
      },
      select: {
        iban: true,
        metadata: true,
        supplier: true,
      },
      orderBy: [{ ocrConfidence: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });

    const extracted: EnrichmentFields = {};
    for (const doc of docs) {
      if (!extracted.iban && doc.iban) {
        extracted.iban = doc.iban;
      }
      const meta = doc.metadata as Record<string, any> | null;
      const ext = meta?.extraction ?? meta;
      const candidateName = doc.supplier || ext?.supplier || ext?.supplierName;
      if (!extracted.name && typeof candidateName === 'string' && !isGenericPartyName(candidateName)) {
        extracted.name = candidateName.trim().slice(0, 200);
      }
      if (!extracted.phone && typeof ext?.supplierPhone === 'string' && ext.supplierPhone.trim()) {
        extracted.phone = ext.supplierPhone.trim();
      }
      if (!extracted.email && typeof ext?.supplierEmail === 'string' && ext.supplierEmail.trim()) {
        extracted.email = ext.supplierEmail.trim();
      }
      if (
        !extracted.address &&
        typeof ext?.supplierAddress === 'string' &&
        ext.supplierAddress.trim() &&
        !/^[-–—\s/.]+$/.test(ext.supplierAddress.trim())
      ) {
        extracted.address = ext.supplierAddress.trim();
      }
      if (!extracted.postalCode && typeof ext?.supplierPostalCode === 'string' && ext.supplierPostalCode.trim()) {
        extracted.postalCode = ext.supplierPostalCode.trim();
      }
      if (!extracted.city && typeof ext?.supplierCity === 'string' && ext.supplierCity.trim()) {
        extracted.city = ext.supplierCity.trim();
      }
      if (!extracted.website && typeof ext?.supplierWebsite === 'string' && ext.supplierWebsite.trim()) {
        extracted.website = ext.supplierWebsite.trim();
      }
    }

    // Heurística de cidade e código postal a partir da morada completa caso ainda vazios
    if (extracted.address) {
      if (!extracted.postalCode) {
        const ptZip = extracted.address.match(/\b\d{4}-\d{3}\b/);
        const esZip = extracted.address.match(/\b\d{5}\b/);
        if (ptZip) extracted.postalCode = ptZip[0];
        else if (esZip) extracted.postalCode = esZip[0];
      }
      if (!extracted.city) {
        extracted.city = this.guessCity(extracted.address);
      }
    }

    return extracted;
  }

  private guessCity(address: string | null): string | null {
    if (!address) return null;
    const parts = address.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const last = parts[parts.length - 1];
    const cityMatch = last.replace(/\b\d{4,5}-?\d{0,3}\b/g, '').trim();
    return cityMatch || null;
  }

  /**
   * Apply the only-fill-nulls rule. Returns the LIST of fields that
   * were actually populated.
   */
  private applyOnlyFillNulls(
    party: Record<string, any>,
    incoming: EnrichmentFields,
  ): string[] {
    const filled: string[] = [];
    for (const field of [
      'email',
      'phone',
      'mobile',
      'address',
      'city',
      'postalCode',
      'website',
      'industry',
      'iban',
    ] as const) {
      const current = party[field];
      const candidate = incoming[field as keyof EnrichmentFields];
      const isCurrentEmpty =
        current == null ||
        (typeof current === 'string' &&
          (current.trim().length === 0 || /^[-–—\s/.]+$/.test(current.trim())));
      if (
        isCurrentEmpty &&
        typeof candidate === 'string' &&
        candidate.trim().length > 0 &&
        !/^[-–—\s/.]+$/.test(candidate.trim())
      ) {
        filled.push(field);
      }
    }
    return filled;
  }

  /**
   * Persist the enrichment.
   */
  private async writeEnrichment(
    tenantId: string,
    partyId: string,
    userId: string,
    source: string,
    fieldsPopulated: string[],
    incoming: EnrichmentFields,
  ): Promise<void> {
    const updateData: Record<string, string> = {};
    for (const f of fieldsPopulated) {
      const value = incoming[f as keyof EnrichmentFields];
      if (typeof value === 'string' && value.length > 0) {
        updateData[f] = value;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.party.update({
        where: { id: partyId },
        data: {
          ...updateData,
          enrichedAt: new Date(),
          enrichmentSource: source,
          enrichmentError: null,
        },
      });
      await this.audit.logInTx(tx as unknown as PrismaClient, {
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'party',
        entityId: partyId,
        metadata: {
          subAction: 'party.enrich',
          source,
          fieldsPopulated,
        },
      });
    });
  }

  /**
   * Record a failed enrichment so the badge can render honestly.
   * Updates `enrichedAt` to null (we don't want a failed run to lock
   * out a future retry via the 30-day gate) and writes the audit row.
   */
  private async recordFailure(
    tenantId: string,
    partyId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.party.update({
        where: { id: partyId },
        data: {
          // Intentionally NOT touching enrichedAt — keeps the gate open
          // for the next attempt.
          enrichmentSource: 'manual',
          enrichmentError: reason,
        },
      });
      await this.audit.logInTx(tx as unknown as PrismaClient, {
        tenantId,
        userId,
        action: AuditAction.EDIT,
        entityType: 'party',
        entityId: partyId,
        metadata: {
          subAction: 'party.enrich.failed',
          reason,
        },
      });
    });
  }

  /**
   * Resolve a provider by name when the caller passed `forceProvider`.
   * Goes through the factory's instances directly so we don't have to
   * expose the providers as separate injections.
   */
  private providerByName(
    name: 'sabi-pt' | 'vies' | 'nif-lookup' | 'invoices' | 'manual' | 'auto',
  ): import('./providers/provider.factory').EnrichmentProvider {
    switch (name) {
      case 'sabi-pt':
        return this.factory['sabiPt'];
      case 'vies':
        return this.factory['vies'];
      case 'manual':
      case 'nif-lookup':
      case 'invoices':
      case 'auto':
      default:
        return this.factory['manual'];
    }
  }
}

/**
 * Result returned to the controller. Mirrors `EnrichmentResponseDto`
 * but keeps the date as a Date object for tests (controller converts
 * to ISO before serializing).
 */
export interface EnrichmentOutcome {
  source: 'sabi-pt' | 'vies' | 'manual' | 'cached' | 'no_data';
  fieldsPopulated: string[];
  error: string | null;
  fetchedAt: Date;
}
