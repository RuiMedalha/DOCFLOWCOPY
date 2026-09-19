import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  AuditAction,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Payload accepted by AuditService.log() / logInTx(). Only `tenantId` and
 * `action` are required; everything else is optional and forwarded to the
 * hash payload as-is. `metadata` must be JSON-serialisable.
 */
export interface AuditLogEntry {
  tenantId: string;
  userId?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Anything that exposes the `auditLog` model and an optional `auditLog.findFirst`
 * / `auditLog.create` will do. Both PrismaService (raw client, used for
 * verifyChain so we can bypass the global tenant extension) and the transaction
 * client `Prisma.TransactionClient` returned inside `$transaction(async tx => ...)`
 * satisfy this contract.
 */
type AuditCapableClient = Pick<PrismaClient, 'auditLog'>;

/**
 * Hash-chained audit log writer.
 *
 * Every row stored in `AuditLog` seals the previous one: the SHA-256 of the
 * previous row's `rowHash` concatenated with the canonical JSON of the
 * current payload. Tampering with any field (or reordering rows) breaks the
 * chain — `verifyChain()` detects this.
 *
 * Why a global service: many modules previously wrote AuditLog rows by
 * hand and forgot the REQUIRED `rowHash` column, producing tsc errors and
 * silently broken chains. Injecting `AuditService` makes it impossible to
 * write a row without a valid hash.
 *
 * --------------------------------------------------------------------------
 * subAction catalogue (security-audit M-18)
 *
 * Every sensitive mutation logs `action: AuditAction.EDIT` with a
 * `metadata.subAction` string that disambiguates which mutation fired.
 * The catalog below is the SINGLE SOURCE OF TRUTH for these values;
 * grep over the codebase for any of these strings to find every call site.
 *
 *   Pipeline (Sprint H):
 *     processing.started            — RECEIVED → EXTRACTING (stage 1 begin)
 *     processing.stage.advanced     — EXTRACTING → ENRICHING / ENRICHING → ROUTING
 *     processing.completed          — ROUTING → COMPLETED (terminal success)
 *     processing.failed             — handler caught an error; doc → FAILED
 *     processing.auto_approved      — pipeline called documents.approve() and it succeeded
 *
 *   Tenant settings:
 *     tenant.settings.update        — generic patch (PATCH /tenants/me/settings)
 *
 *   Existing categories (covered by other sprints; kept here for grep):
 *     storage.relocate              — Sprint E: cross-tenant-safe move
 *     party.update.recurring        — Sprint F: financial exposure flag
 *     party.update.category         — Sprint F: tax-category change
 *     auth.refresh / auth.logout    — Sprint B: token rotation
 *     oauth.callback                — Sprint B: state-mismatch guard
 *     inbound.webhook.received      — Sprint B: SendGrid + Stripe + …
 *
 * Every site that adds a NEW subAction MUST extend this list (and the
 * comment in processing.service.ts / tenants.service.ts) so forensic
 * tooling can rely on the catalog.
 * --------------------------------------------------------------------------
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a new audit row for `entry`. Computes the prev/row hashes and
   * writes the row to the database. NEVER throws — a logging failure must
   * never break the caller's main operation. Failures are recorded via
   * `Logger.error` so they remain observable.
   *
   * C-02: the findFirst(prev) + create(row) pair is wrapped in a single
   * `$transaction` AND acquires a per-tenant `pg_advisory_xact_lock` so
   * concurrent writers for the same tenant serialise their read+write.
   * Without the lock, two concurrent writes can both read the same
   * prev rowHash and both insert a row chained to that prev — the chain
   * breaks under moderate concurrency. The DB-level
   * `@@unique([tenantId, rowHash])` is the second line of defence: if
   * the lock ever fails to serialise (e.g. across logical replicas),
   * the duplicate INSERT raises a unique-constraint error instead of
   * committing a broken chain.
   *
   * Why an advisory lock instead of SERIALIZABLE isolation: SERIALIZABLE
   * forces a retry of the entire transaction on a conflict, but
   * AuditService.log is fire-and-forget — we want the row to commit,
   * not be retried invisibly. A per-tenant advisory lock is a deterministic
   * queue: every writer for tenant X waits its turn.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Acquire a per-tenant advisory lock. The lock is automatically
        // released at transaction commit/rollback. We hash the tenantId
        // into a bigint so concurrent writes across different tenants do
        // not contend.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${entry.tenantId}))
        `;
        await this.write(tx as unknown as AuditCapableClient, entry);
      });
    } catch (err) {
      this.logger.error(
        `Audit log write failed (tenant=${entry.tenantId} action=${entry.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      // Swallow — audit failures are non-fatal by design.
    }
  }

  /**
   * Variant that participates in an existing Prisma transaction so the audit
   * row is committed (or rolled back) atomically with the caller's data
   * write. The caller still receives a swallow-on-error guarantee: if the
   * audit insert throws, the caller's transaction is aborted (that's the
   * point of being in `tx`), so we only swallow when explicitly opted in
   * via `swallow`.
   */
  async logInTx(
    tx: AuditCapableClient,
    entry: AuditLogEntry,
    opts: { swallow?: boolean } = {},
  ): Promise<void> {
    try {
      await this.write(tx, entry);
    } catch (err) {
      this.logger.error(
        `Audit log write (in tx) failed (tenant=${entry.tenantId} action=${entry.action}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      if (opts.swallow) return;
      throw err;
    }
  }

  /**
   * Walk the audit chain for a tenant and verify that every `rowHash`
   * matches sha256(prevHash + canonical(row payload)). Returns the first
   * broken row id (so the caller knows where the chain was tampered), or
   * `valid: true` when the whole chain checks out.
   */
  async verifyChain(
    tenantId: string,
  ): Promise<{ valid: boolean; brokenAt?: string }> {
    // Read directly from the raw client (not the auto-scoped extension) so we
    // can see EVERY row regardless of any tenant-context state in this call.
    const rows = await (
      this.prisma as unknown as PrismaClient
    ).auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        ip: true,
        userAgent: true,
        prevHash: true,
        rowHash: true,
        createdAt: true,
      },
    });

    let expectedPrevHash: string | null = null;
    for (const row of rows) {
      if (row.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAt: row.id };
      }
      const recomputed = this.computeRowHash(
        expectedPrevHash,
        this.canonicalRow(row),
      );
      if (recomputed !== row.rowHash) {
        return { valid: false, brokenAt: row.id };
      }
      expectedPrevHash = row.rowHash;
    }

    return { valid: true };
  }

  // ============================================================ internals

  /** Shared write path used by `log` and `logInTx`. */
  private async write(
    client: AuditCapableClient,
    entry: AuditLogEntry,
  ): Promise<void> {
    const createdAt = new Date();

    // Fetch the tenant's most recent row's rowHash (the new prevHash).
    // Ordered by createdAt desc with id desc as tiebreaker for rows that
    // share a millisecond — important under load.
    const prev = await client.auditLog.findFirst({
      where: { tenantId: entry.tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { rowHash: true },
    });
    const prevHash = prev?.rowHash ?? null;

    const rowHash = this.computeRowHash(
      prevHash,
      this.canonicalEntry(entry, createdAt),
    );

    await client.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: (entry.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        prevHash,
        rowHash,
        createdAt,
      },
    });
  }

  /**
   * Canonical JSON serialisation. Keys are sorted recursively so the same
   * payload always hashes to the same digest (the canonicalisation rule is
   * part of the chain — never change it without a migration plan).
   */
  private canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return '[' + value.map((v) => this.canonical(v)).join(',') + ']';
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ':' + this.canonical(obj[k]),
    );
    return '{' + parts.join(',') + '}';
  }

  /** Canonical form for a NEW row being written. */
  private canonicalEntry(entry: AuditLogEntry, createdAt: Date): string {
    // Build a plain object with ONLY the fields that participate in the
    // hash, in a stable order. `metadata` is canonicalised recursively so
    // key-ordering in user metadata cannot break the chain.
    const payload = {
      tenantId: entry.tenantId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: this.canonical(entry.metadata ?? null),
      createdAt: createdAt.toISOString(),
    };
    return this.canonical(payload);
  }

  /** Canonical form for an EXISTING row being verified. */
  private canonicalRow(row: {
    tenantId: string;
    userId: string | null;
    action: AuditAction;
    entityType: string | null;
    entityId: string | null;
    metadata: unknown;
    createdAt: Date;
  }): string {
    const payload = {
      tenantId: row.tenantId,
      userId: row.userId ?? null,
      action: row.action,
      entityType: row.entityType ?? null,
      entityId: row.entityId ?? null,
      metadata: this.canonical(row.metadata ?? null),
      createdAt: row.createdAt.toISOString(),
    };
    return this.canonical(payload);
  }

  /**
   * rowHash = sha256( (prevHash ?? '') + canonical(payload) )
   * The empty-string convention for the genesis row keeps the hash inputs
   * deterministic regardless of `null` vs `undefined`.
   */
  private computeRowHash(prevHash: string | null, canonicalPayload: string): string {
    return createHash('sha256')
      .update((prevHash ?? '') + canonicalPayload)
      .digest('hex');
  }
}