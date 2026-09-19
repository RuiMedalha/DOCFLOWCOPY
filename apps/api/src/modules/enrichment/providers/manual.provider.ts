import { Injectable, Logger } from '@nestjs/common';
import type {
  EnrichmentProvider,
  EnrichmentResult,
  ProviderInput,
} from './provider.factory';

/**
 * ManualProvider — the no-op fallback for cases where neither Sabi PT
 * nor VIES apply (extra-EU without a public registry; or a Party
 * without an IBAN/country to disambiguate).
 *
 * Returns `{ ok: false, source: 'manual', reason }`. The service
 * records this on the Party row as `enrichmentError = reason` so the
 * UI badge can show "Manual enrichment needed".
 *
 * Keeping it as a real provider (not a `null` fallback) means the
 * factory call-site is uniform: every input maps to ONE provider,
 * there's no special-case branching in the service.
 */
@Injectable()
export class ManualProvider implements EnrichmentProvider {
  readonly name = 'manual' as const;
  private readonly logger = new Logger(ManualProvider.name);

  async fetch(input: ProviderInput): Promise<EnrichmentResult> {
    this.logger.log(
      `[manual] manual enrichment needed — ` +
        `country=${input.country ?? 'null'} iban=${
          input.iban ? input.iban.slice(0, 4) + '***' : 'null'
        } nif=${input.nif ?? 'null'}`,
    );
    const reason = !input.country && !input.iban
      ? 'no_nif_no_iban'
      : 'extra_eu_no_api';
    return { ok: false, source: 'manual', reason };
  }
}
