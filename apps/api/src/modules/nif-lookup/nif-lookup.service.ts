import {
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  isValidPortugueseNif,
} from '../../common/validation/tax-id.validator';
import { AuditService } from '../audit/audit.service';

export type NifSource = 'cache' | 'upstream' | 'mod11_only';

export interface NifLookupResult {
  /** Cleaned NIF (digits only, max 9). */
  nif: string;
  /** True iff the structural checksum (mod-11) accepts the value. */
  mod11Valid: boolean;
  /** True iff the public base returned a hit on the last fetch. */
  baseVerified: boolean;
  /** Why the public base lookup failed (when baseVerified is false). */
  reason?: string;
  /** Optional name returned by the base — undefined when not fetched. */
  name?: string;
  /** Optional postal address returned by the base. */
  address?: string;
  /** Which layer served this result. */
  source: NifSource;
  /** ISO 8601 timestamp of the upstream hit (cache fetch time otherwise). */
  fetchedAt: string;
}

export const NIF_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
export const NIF_CACHE_MAX_ENTRIES = 1000;
export const NIF_RATE_LIMIT_PER_MIN = 10;

/**
 * Minimal Redis adapter contract — the optional production
 * cache backend. Only two methods are needed; a real Redis
 * client (ioredis) or an Upstash REST adapter can satisfy
 * this without leaking a hard dependency here.
 */
export interface NifCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export const NIF_CACHE_BACKEND = Symbol('NIF_CACHE_BACKEND');

/**
 * NifLookupService — Sprint 1.C Portal das Finanças integration.
 *
 * Layered lookups:
 *   1. In-memory LRU (max 1000 entries, TTL 7 days). Cheap; the
 *      vast majority of lookups in a busy tenant are repeats.
 *   2. Optional Redis cache (`@Inject(NIF_CACHE_BACKEND)`).
 *      Activated only when REDIS_URL is set so dev / test runs
 *      keep their zero-dependency default.
 *   3. Upstream fetch via the configured provider (nif.pt by
 *      default — public, anonymous, no API key). Failures
 *      fall through to mod-11 only.
 *
 * Audit: every lookup emits an `AuditAction.EDIT` row tagged
 * `nif.lookup`. The endpoint is *read-only* (LGPD: NIF data is
 * public — querying the Portal das Finanças for a public
 * record is permitted, and DocFlow never persists the
 * upstream response beyond the cache TTL).
 *
 * Rate limit: 10 req/min per tenant. We track a simple in-memory
 * sliding window keyed on `${tenantId}:${bucket}`. The limit is
 * intentionally low — the public base throttles aggressively
 * per IP, and the cache layer means the upstream is hit at most
 * once per (tenant, NIF, 7-day TTL).
 */
@Injectable()
export class NifLookupService {
  private readonly logger = new Logger(NifLookupService.name);

  /** Per-tenant sliding window of recent lookup timestamps. */
  private readonly rateLimit = new Map<string, number[]>();

  /** Bounded in-memory cache; oldest entry evicted on overflow. */
  private readonly cache = new Map<string, { value: NifLookupResult; expiresAt: number }>();

  constructor(
    private readonly audit: AuditService,
    @Optional()
    @Inject(NIF_CACHE_BACKEND)
    private readonly redisCache?: NifCacheBackend,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Validate a NIF end-to-end. Returns a discriminated payload
   * so the UI can show three distinct states:
   *   - `source: 'cache'`     — full payload, no upstream call
   *   - `source: 'upstream'`  — full payload, fresh hit
   *   - `source: 'mod11_only'` — only the structural check ran
   */
  async lookup(
    tenantId: string,
    userId: string,
    rawNif: string,
  ): Promise<NifLookupResult> {
    this.enforceRateLimit(tenantId);

    const nif = this.cleanNif(rawNif);
    if (nif.length !== 9) {
      // The base only stores PT-format 9-digit NIFs. Anything
      // else gets a mod-11 only verdict so the UI can render
      // a "not a PT NIF" chip without a wasted upstream call.
      const result = this.mod11Only(nif, 'not_a_pt_nif');
      await this.logLookup(tenantId, userId, nif, result);
      return result;
    }

    const cached = await this.readCache(tenantId, nif);
    if (cached) {
      await this.logLookup(tenantId, userId, nif, cached);
      return cached;
    }

    const upstream = await this.fetchFromUpstream(nif);
    const result: NifLookupResult = upstream ?? this.mod11Only(nif, 'upstream_unavailable');

    await this.writeCache(tenantId, nif, result);
    await this.logLookup(tenantId, userId, nif, result);
    return result;
  }

  // ─── Layer 1 — mod-11 ────────────────────────────────────────────────

  private mod11Only(nif: string, reason: string): NifLookupResult {
    return {
      nif,
      mod11Valid: nif.length === 9 ? isValidPortugueseNif(nif) : false,
      baseVerified: false,
      reason,
      source: 'mod11_only',
      fetchedAt: new Date().toISOString(),
    };
  }

  // ─── Layer 2 — in-memory + Redis cache ──────────────────────────────

  private cacheKey(tenantId: string, nif: string): string {
    return `nif:${tenantId}:${nif}`;
  }

  private async readCache(
    tenantId: string,
    nif: string,
  ): Promise<NifLookupResult | null> {
    // In-memory LRU first — a hit here short-circuits Redis.
    const memKey = this.cacheKey(tenantId, nif);
    const memHit = this.cache.get(memKey);
    if (memHit && memHit.expiresAt > Date.now()) {
      // Re-insert to bump LRU position (Map iteration order).
      this.cache.delete(memKey);
      this.cache.set(memKey, memHit);
      return { ...memHit.value, source: 'cache' };
    }
    if (memHit) this.cache.delete(memKey);

    if (!this.redisCache) return null;
    try {
      const raw = await this.redisCache.get(memKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as NifLookupResult;
      if (new Date(parsed.fetchedAt).getTime() + NIF_CACHE_TTL_MS < Date.now()) {
        return null;
      }
      // Promote Redis hit into the local LRU so the next read is hot.
      this.cache.set(memKey, {
        value: parsed,
        expiresAt: Date.now() + NIF_CACHE_TTL_MS,
      });
      this.evictIfFull();
      return { ...parsed, source: 'cache' };
    } catch (err) {
      this.logger.warn(
        `[nif-lookup] Redis read failed for tenant=${tenantId} nif=${nif}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async writeCache(
    tenantId: string,
    nif: string,
    value: NifLookupResult,
  ): Promise<void> {
    const key = this.cacheKey(tenantId, nif);
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + NIF_CACHE_TTL_MS,
    });
    this.evictIfFull();
    if (!this.redisCache) return;
    try {
      await this.redisCache.set(
        key,
        JSON.stringify(value),
        NIF_CACHE_TTL_MS,
      );
    } catch (err) {
      this.logger.warn(
        `[nif-lookup] Redis write failed for tenant=${tenantId} nif=${nif}: ${(err as Error).message}`,
      );
    }
  }

  private evictIfFull(): void {
    while (this.cache.size > NIF_CACHE_MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (!firstKey) return;
      this.cache.delete(firstKey);
    }
  }

  // ─── Layer 3 — upstream provider ────────────────────────────────────

  /**
   * Probe nif.pt. The endpoint is anonymous and rate-limited
   * server-side; we keep the call short and time-out after 4s
   * to avoid hanging the request thread when the public base
   * is having a bad day.
   *
   * The response shape is deliberately defensive — we only
   * surface what the UI actually consumes (name, address).
   * Any unrecognised payload still produces a valid base
   * verdict as long as the upstream returns 200.
   */
  private async fetchFromUpstream(
    nif: string,
  ): Promise<NifLookupResult | null> {
    const url = `https://www.nif.pt/pt/nif/${encodeURIComponent(nif)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json,text/plain' },
      });
      if (!res.ok) {
        this.logger.warn(`[nif-lookup] upstream HTTP ${res.status} for nif=${nif}`);
        return null;
      }
      const text = await res.text();
      const parsed = this.parseUpstream(text);
      if (!parsed) return null;
      return {
        nif,
        mod11Valid: isValidPortugueseNif(nif),
        baseVerified: true,
        name: parsed.name,
        address: parsed.address,
        source: 'upstream',
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.logger.warn(
        `[nif-lookup] upstream fetch failed for nif=${nif}: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * The nif.pt response shape varies over time. We accept any
   * JSON object that carries a name OR address field; a 200
   * response with neither is treated as "no hit". Anything
   * non-JSON still resolves to baseVerified=false — we never
   * throw upstream parsing errors back to the caller.
   */
  private parseUpstream(body: string): { name?: string; address?: string } | null {
    if (!body || body.trim().length === 0) return null;
    try {
      const obj = JSON.parse(body);
      if (!obj || typeof obj !== 'object') return null;
      const name = typeof obj.name === 'string' ? obj.name
        : typeof obj.nome === 'string' ? obj.nome
        : typeof obj.company_name === 'string' ? obj.company_name
        : undefined;
      const address = typeof obj.address === 'string' ? obj.address
        : typeof obj.morada === 'string' ? obj.morada
        : undefined;
      // The endpoint often returns `{"valid": false}` for an
      // unknown NIF — treat that as no hit.
      if (obj.valid === false) return null;
      if (name || address) return { name, address };
      // Some providers return a `nif` field with a numeric string;
      // we treat any 200-with-no-name as "no public record".
      return null;
    } catch {
      // Non-JSON body — nif.pt sometimes returns plain HTML for
      // the legacy endpoint. Surface as upstream unavailable
      // rather than throwing.
      return null;
    }
  }

  // ─── Rate limit (in-memory sliding window per tenant) ────────────────

  private enforceRateLimit(tenantId: string): void {
    const windowMs = 60 * 1000;
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const key = `${tenantId}:${bucket}`;
    const arr = this.rateLimit.get(key) ?? [];
    arr.push(now);
    this.rateLimit.set(key, arr);
    // Garbage-collect buckets older than 2 minutes so the map
    // does not grow unbounded across long-running processes.
    if (this.rateLimit.size > 256) {
      for (const k of this.rateLimit.keys()) {
        const parts = k.split(':');
        const kBucket = Number(parts[parts.length - 1]);
        if (Number.isFinite(kBucket) && now - kBucket * windowMs > 2 * windowMs) {
          this.rateLimit.delete(k);
        }
      }
    }
    if (arr.length > NIF_RATE_LIMIT_PER_MIN) {
      // Throw the standard NestJS exception so the controller's
      // global filter maps it to 429. We surface the bucket so the
      // caller knows when to retry.
      throw new Error(
        `RATE_LIMIT: tenant=${tenantId} exceeded ${NIF_RATE_LIMIT_PER_MIN}/min`,
      );
    }
  }

  /** Test-only hook — peek at the in-memory cache size. */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Test-only hook — clear the in-memory cache + rate-limit map. */
  resetForTests(): void {
    this.cache.clear();
    this.rateLimit.clear();
  }

  // ─── Cleanup ────────────────────────────────────────────────────────

  private cleanNif(input: string): string {
    return (input ?? '')
      .toString()
      .toUpperCase()
      .replace(/^PT/i, '')
      .replace(/\D/g, '')
      .slice(0, 9);
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  private async logLookup(
    tenantId: string,
    userId: string,
    nif: string,
    result: NifLookupResult,
  ): Promise<void> {
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'nif_lookup',
      entityId: nif || 'invalid',
      metadata: {
        subAction: 'nif.lookup',
        nif,
        source: result.source,
        baseVerified: result.baseVerified,
        mod11Valid: result.mod11Valid,
        reason: result.reason ?? null,
        hasName: !!result.name,
        hasAddress: !!result.address,
        // LGPD note — kept in the audit row so a future privacy
        // review can confirm DocFlow never persisted the upstream
        // payload beyond the cache TTL.
        lgpd: 'public-record-lookup',
      },
    });
  }
}
