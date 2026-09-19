import { Injectable, Logger } from '@nestjs/common';
import { parsePostalAddress } from '../../vies/address-parser';
import type {
  EnrichmentProvider,
  EnrichmentResult,
  ProviderInput,
} from './provider.factory';

/**
 * ViesProvider — queries the EU VAT Information Exchange System (VIES)
 * for a VAT number. Free, no auth, but rate-limited (generous; we
 * still cap at 5s to avoid hangs).
 *
 * Endpoint contract (REST wrapper documented by the EC; the canonical
 * service is SOAP but the REST wrapper is the supported one):
 *   POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number-service
 *   Content-Type: application/json
 *   { countryCode, vatNumber }
 * → { valid, name, address, requestIdentifier }
 *
 * Why a simple `fetch` rather than `vies` npm: the npm package pins
 * `axios` and `soap` which drag in transitively — keeping the
 * dependency surface small matters for an MVP. We only need one
 * endpoint, so the bare `fetch` is enough.
 *
 * Behaviour mirrors SabiPtProvider:
 *   - 5s hard timeout.
 *   - On transport error → `{ ok: false, source: 'manual', reason: 'timeout' | 'transport_error' }`.
 *   - On `valid: false` → treat as "no data" so the operator can fill manually.
 *   - VIES only returns `name` + `address`; phone/email/etc are NOT
 *     in the payload so we leave them as null. The factory's
 *     `only-fill-nulls` rule makes this safe — we just skip those fields.
 */
@Injectable()
export class ViesProvider implements EnrichmentProvider {
  readonly name = 'vies' as const;
  private readonly logger = new Logger(ViesProvider.name);
  // Fase 4.2 (P1.1) — bug real que causava a contradição no painel: a
  // ficha do IKEA mostrava "vies_http_error" (enriquecimento manual
  // necessário) AO MESMO TEMPO que "Estado VIES: Válido". Este endpoint
  // tinha o sufixo `-service`, que devolve HTTP de erro; o endpoint
  // oficial confirmado por curl (2026-09-11) e já usado por
  // `ViesService` (a chamada que o botão "Validar no VIES" dispara) é
  // sem o sufixo. Duas integrações VIES, duas URLs, uma errada.
  private readonly endpoint =
    'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

  async fetch(input: ProviderInput): Promise<EnrichmentResult> {
    if (!input.country) {
      return { ok: false, source: 'manual', reason: 'unknown_country' };
    }
    if (!input.nif) {
      return { ok: false, source: 'manual', reason: 'no_nif_no_iban' };
    }

    const countryCode = input.country.toUpperCase().trim();
    const rawNif = input.nif.trim();
    const cleanVat = rawNif.toUpperCase().startsWith(countryCode)
      ? rawNif.slice(countryCode.length).trim()
      : rawNif;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode,
          vatNumber: cleanVat,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        this.logger.warn(
          `[vies] country=${input.country} vat=${input.nif} status=${response.status}`,
        );
        return { ok: false, source: 'manual', reason: 'vies_http_error' };
      }

      const body = (await response.json()) as Record<string, unknown>;
      const valid = body.valid === true;
      if (!valid) {
        this.logger.warn(
          `[vies] country=${input.country} vat=${input.nif} valid=false`,
        );
        return { ok: false, source: 'manual', reason: 'vies_invalid_vat' };
      }

      return {
        ok: true,
        source: 'vies',
        fields: this.mapViesResponse(body),
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[vies] fetch FAILED for country=${input.country} vat=${input.nif}: ${msg}`,
      );
      return {
        ok: false,
        source: 'manual',
        reason: msg.includes('abort') ? 'timeout' : 'transport_error',
      };
    }
  }

  /**
   * VIES payload is sparse — typically just `name` + `address`. We
   * leave phone/email/website as null so the only-fill-nulls rule
   * doesn't accidentally zero out a manually-entered phone.
   */
  private mapViesResponse(
    body: Record<string, unknown>,
  ): import('./provider.factory').EnrichmentFields {
    const pick = (k: string): string | null => {
      const v = body[k];
      if (typeof v !== 'string') return null;
      const clean = v.trim();
      if (!clean || /^[-–—\s/._*#]+$/.test(clean) || clean.toLowerCase() === '---') {
        return null;
      }
      return clean;
    };
    const address = pick('address');
    const name = pick('name');
    const parsed = parsePostalAddress(address);
    return {
      name: name ?? null,
      // VIES does not expose email/phone/mobile/website — leave null.
      email: null,
      phone: null,
      mobile: null,
      address: parsed.address ?? address ?? null,
      city: parsed.city ?? this.guessCity(address),
      postalCode: parsed.postalCode ?? this.guessPostalCode(address),
      website: null,
      industry: null,
    };
  }

  /**
   * Best-effort extraction of `<postalCode>` from a freeform VIES
   * address. VIES PT addresses look like "RUA X, 12, 1050-070 LISBOA"
   * so we look for a 4-7 digit hyphen-separated token. Returns null
   * when no match — caller falls back to the whole address string.
   */
  private guessPostalCode(address: string | null): string | null {
    if (!address) return null;
    const m = address.match(/\b(\d{4,5}-?\d{0,3})\b/);
    return m ? m[1] : null;
  }

  /**
   * Best-effort city guess: scan the address tokens for the last
   * chunk that contains letters and not just digits. VIES often packs
   * the city at the end ("... 28013 MADRID") and we want "MADRID"
   * even though the comma-split leaves it glued to the postal code.
   */
  private guessCity(address: string | null): string | null {
    if (!address) return null;
    const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      // Strip a leading postal-code token (digits + optional hyphen)
      // so "28013 MADRID" becomes "MADRID".
      const stripped = parts[i].replace(/^\d{4,5}(-\d{0,3})?\s+/, '').trim();
      if (/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-]*$/.test(stripped)) return stripped;
    }
    return null;
  }
}
