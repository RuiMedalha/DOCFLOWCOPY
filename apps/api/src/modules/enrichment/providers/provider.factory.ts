import { Injectable, Logger } from '@nestjs/common';
import { SabiPtProvider } from './sabi-pt.provider';
import { ViesProvider } from './vies.provider';
import { ManualProvider } from './manual.provider';

/**
 * EnrichmentProvider — uniform contract every provider implements.
 * Returns a flat record of fields to merge into the Party row, or
 * `null` when the provider has no usable data (which is distinct
 * from "the call failed" — see `error` field).
 *
 * Fields are returned in the SAME shape as Party columns so the
 * service can do a straight `Object.assign(existing, fields)` after
 * filtering out already-set fields.
 */
export type EnrichmentFields = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  website?: string | null;
  industry?: string | null;
  iban?: string | null;
};

export type EnrichmentResult =
  | { ok: true; source: 'sabi-pt' | 'vies'; fields: EnrichmentFields }
  | { ok: false; source: 'manual'; reason: string };

export interface EnrichmentProvider {
  readonly name: 'sabi-pt' | 'vies' | 'manual';
  /** Fetch fields for the given NIF/VAT/IBAN. MUST never throw. */
  fetch(input: ProviderInput): Promise<EnrichmentResult>;
}

export interface ProviderInput {
  nif: string | null;
  country: string | null;
  iban: string | null;
}

/**
 * EU country codes (ISO 3166-1 alpha-2). Kept inline (not imported
 * from `@docflow/shared`) so the factory stays testable in isolation
 * without dragging the shared package into enrichment tests. This is
 * the canonical EU list as of 2026 — includes all 27 member states.
 */
const EU_COUNTRIES = new Set<string>([
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
]);

/**
 * EnrichmentProviderFactory — picks the right provider for a Party
 * based on country / IBAN prefix. Decision rules:
 *
 *   1. `country === 'PT'` or `iban` starts with `PT50` → Sabi PT
 *      (PT has its own company registry, Sabi is the canonical public
 *      API; VIES works for PT but returns less data).
 *   2. `country` ∈ EU or `iban` prefix ∈ EU → VIES
 *      (returns name + address; phone/email are NOT in the VIES
 *      payload, so we may end up with a partial fill).
 *   3. anything else → ManualProvider (no-op + log).
 *
 * The factory NEVER throws on a missing/unknown country — that's the
 * common dev/test case and we want a graceful no-op rather than a 500.
 */
@Injectable()
export class EnrichmentProviderFactory {
  private readonly logger = new Logger(EnrichmentProviderFactory.name);

  constructor(
    private readonly sabiPt: SabiPtProvider,
    private readonly vies: ViesProvider,
    private readonly manual: ManualProvider,
  ) {}

  pick(country: string | null, iban: string | null): EnrichmentProvider {
    const c = (country ?? '').toUpperCase().trim();
    const ib = (iban ?? '').toUpperCase().replace(/\s+/g, '');

    // ── Fase 4.1 (P2.3) — a SABI está desligada ──────────────────────
    // A SABI (Bureau van Dijk / Moody's) é uma base de dados paga que a
    // HotelEquip não subscreve, e a ficha de entidade andava a mostrar
    // `sabi_api_key_missing` como se fosse uma avaria. Portugal passa
    // pelo VIES, que é gratuito, não precisa de chave e devolve nome e
    // morada a partir do NIF-IVA. O provider fica no código (não é
    // apagado) para o dia em que houver subscrição: basta repor esta
    // condição.
    if (c === 'PT' || ib.startsWith('PT50')) {
      this.logger.debug(`[pick] country=${c} iban=${ib.slice(0, 4)} → vies (sabi-pt desligada)`);
      return this.vies;
    }

    if (c && EU_COUNTRIES.has(c)) {
      this.logger.debug(
        `[pick] country=${c} → vies`,
      );
      return this.vies;
    }

    if (ib.length >= 2) {
      const prefix = ib.slice(0, 2);
      if (EU_COUNTRIES.has(prefix)) {
        this.logger.debug(
          `[pick] iban prefix=${prefix} → vies`,
        );
        return this.vies;
      }
    }

    this.logger.debug(
      `[pick] country=${c} iban=${ib.slice(0, 4)} → manual ` +
        `(extra-EU or no data)`,
    );
    return this.manual;
  }

  /**
   * Test-only helper: expose the EU set so unit tests can assert
   * the country membership without hard-coding the list twice.
   */
  static isEuCountry(country: string | null): boolean {
    if (!country) return false;
    return EU_COUNTRIES.has(country.toUpperCase().trim());
  }
}
