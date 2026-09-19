import { Global, Injectable, Logger, Module } from '@nestjs/common';

/**
 * Fase 4 — ECB reference exchange rates via the official SDMX data API:
 *   GET https://data-api.ecb.europa.eu/service/data/EXR/D.{CUR}.EUR.SP00.A
 *       ?startPeriod=YYYY-MM-DD&endPeriod=YYYY-MM-DD&format=csvdata
 * (confirmed with curl on 2026-09-11: D.GBP.EUR.SP00.A 2026-02-04 → 0.8616).
 *
 * The rate is "units of CUR per 1 EUR"; amountEur = amount / rate. For a
 * date without a fixing (weekend/holiday) the latest fixing in the 10
 * previous days is used and reported as `rateDate`.
 */
export interface FxRate {
  currency: string;
  rate: number;
  rateDate: string; // YYYY-MM-DD of the fixing actually used
}

@Injectable()
export class EcbFxService {
  private readonly logger = new Logger(EcbFxService.name);
  private readonly base = (process.env.ECB_FX_URL?.trim() || 'https://data-api.ecb.europa.eu/service/data/EXR').replace(/\/+$/, '');
  private readonly cache = new Map<string, FxRate | null>();

  /** Rate for `currency` on `date` (Date or YYYY-MM-DD). EUR → 1. Null when unavailable. */
  async rateToEur(currency: string, date: Date | string): Promise<FxRate | null> {
    const cur = (currency ?? '').trim().toUpperCase();
    const day = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
    if (!cur || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    if (cur === 'EUR') return { currency: 'EUR', rate: 1, rateDate: day };
    const key = `${cur}:${day}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const result = await this.fetchRate(cur, day);
    this.cache.set(key, result);
    return result;
  }

  /** Convert an amount in `currency` on `date` to EUR (2 decimals). */
  async toEur(amount: number, currency: string, date: Date | string): Promise<{ amountEur: number; rate: FxRate } | null> {
    const rate = await this.rateToEur(currency, date);
    if (!rate || !Number.isFinite(rate.rate) || rate.rate <= 0) return null;
    return { amountEur: Math.round((amount / rate.rate) * 100) / 100, rate };
  }

  private async fetchRate(cur: string, day: string): Promise<FxRate | null> {
    const end = new Date(`${day}T00:00:00Z`);
    const start = new Date(end.getTime() - 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const url = `${this.base}/D.${encodeURIComponent(cur)}.EUR.SP00.A?startPeriod=${start}&endPeriod=${day}&format=csvdata`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/csv' } });
      clearTimeout(timer);
      if (!res.ok) {
        this.logger.warn(`[ecb] ${cur} ${day} → HTTP ${res.status}`);
        return null;
      }
      const csv = await res.text();
      const parsed = parseEcbCsv(csv);
      if (parsed.length === 0) return null;
      const last = parsed[parsed.length - 1];
      return { currency: cur, rate: last.value, rateDate: last.date };
    } catch (err) {
      clearTimeout(timer);
      this.logger.warn(`[ecb] ${cur} ${day} failed: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Parse the ECB csvdata format: header row with TIME_PERIOD/OBS_VALUE columns. */
export function parseEcbCsv(csv: string): Array<{ date: string; value: number }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const ti = header.indexOf('TIME_PERIOD');
  const vi = header.indexOf('OBS_VALUE');
  if (ti < 0 || vi < 0) return [];
  const out: Array<{ date: string; value: number }> = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const date = cols[ti];
    const value = Number(cols[vi]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && Number.isFinite(value) && value > 0) {
      out.push({ date, value });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

@Global()
@Module({ providers: [EcbFxService], exports: [EcbFxService] })
export class FxModule {}
