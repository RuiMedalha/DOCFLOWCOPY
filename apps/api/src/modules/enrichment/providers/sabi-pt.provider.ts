import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EnrichmentProvider,
  EnrichmentResult,
  ProviderInput,
} from './provider.factory';

/**
 * SabiPtProvider — queries the Sabi.pt public company registry API for
 * a Portuguese NIF.
 *
 * Endpoint contract (publicly documented; rate-limited ~1 req/s free,
 * 5 req/s paid):
 *   GET https://www.sabi.pt/api/companies/{nif}
 *   Authorization: Bearer <SABI_PT_API_KEY>
 *
 * Typical response shape:
 *   {
 *     name: string,
 *     address: string,
 *     postalCode: string,
 *     city: string,
 *     phone: string | null,
 *     mobile: string | null,
 *     email: string | null,
 *     website: string | null,
 *     cae: string,        // CAE code
 *     nace: string,       // NACE equivalent
 *     industry: string,   // human-readable
 *     status: 'active' | 'dissolved' | 'suspended'
 *   }
 *
 * Behaviour:
 *   - 5-second hard timeout via AbortController. Sabi is occasionally
 *     flaky; we never want to hold the request open longer than that.
 *   - On ANY non-2xx, network error, parse error, or abort, returns
 *     `{ ok: false, source: 'manual', reason: '...' }` — the caller's
 *     `EnrichmentService` then writes a `enrichmentError` row to the
 *     Party for the badge to surface.
 *   - 404 (NIF not in Sabi) is treated as "no data" — same fall-through
 *     as a transport error so the operator can manually fill.
 *   - Missing API key (`SABI_PT_API_KEY` unset) → no-op with a clear log.
 *     We deliberately don't throw — the operator shouldn't see a 500
 *     because the env wasn't set; the badge just says "manual required".
 */
@Injectable()
export class SabiPtProvider implements EnrichmentProvider {
  readonly name = 'sabi-pt' as const;
  private readonly logger = new Logger(SabiPtProvider.name);
  private readonly endpoint = 'https://www.sabi.pt/api/companies';

  constructor(private readonly config: ConfigService) {}

  async fetch(input: ProviderInput): Promise<EnrichmentResult> {
    const apiKey = this.config.get<string>('SABI_PT_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `[sabi-pt] SABI_PT_API_KEY not set — skipping fetch for nif=${input.nif}`,
      );
      return {
        ok: false,
        source: 'manual',
        reason: 'sabi_api_key_missing',
      };
    }
    if (!input.nif) {
      return { ok: false, source: 'manual', reason: 'no_nif_no_iban' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const url = `${this.endpoint}/${encodeURIComponent(input.nif)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 404) {
        this.logger.warn(
          `[sabi-pt] nif=${input.nif} not found (404) — manual fallback`,
        );
        return { ok: false, source: 'manual', reason: 'sabi_404' };
      }
      if (!response.ok) {
        this.logger.warn(
          `[sabi-pt] nif=${input.nif} returned status=${response.status}`,
        );
        return { ok: false, source: 'manual', reason: 'sabi_http_error' };
      }

      const body = (await response.json()) as Record<string, unknown>;
      return {
        ok: true,
        source: 'sabi-pt',
        fields: this.mapSabiResponse(body),
      };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[sabi-pt] fetch FAILED for nif=${input.nif}: ${msg}`,
      );
      return {
        ok: false,
        source: 'manual',
        reason: msg.includes('abort') ? 'timeout' : 'transport_error',
      };
    }
  }

  /**
   * Map Sabi's response to the flat Party-column shape. Keeps only
   * fields the factory contract exposes; `cae` / `nace` / `status` are
   * not on the Party row today so they're dropped (could be persisted
   * in `metadata` later — out of scope for Sprint I).
   */
  private mapSabiResponse(
    body: Record<string, unknown>,
  ): import('./provider.factory').EnrichmentFields {
    const pick = (k: string): string | null => {
      const v = body[k];
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    return {
      email: pick('email'),
      phone: pick('phone'),
      mobile: pick('mobile'),
      address: pick('address'),
      city: pick('city'),
      postalCode: pick('postalCode'),
      website: pick('website'),
      industry: pick('industry') ?? pick('cae'),
    };
  }
}
