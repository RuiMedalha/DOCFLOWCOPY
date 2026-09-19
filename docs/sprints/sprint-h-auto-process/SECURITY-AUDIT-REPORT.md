# Sprint H — Security Audit Report (Security-Auditor)

**Auditor:** Opus 5 persona security-auditor
**Audit target:** Branch `feat/auto-process-pipeline` (3 commits ahead of `main`)
**HEAD audited:** `d069589 feat(pipeline): frontend SSE consumer + auto-approve toggle`
**Skill loaded:** `oc-api-audit` ✅ · `oc-billing-webhooks` ✅
**Working dir:** `C:\Projetos\docflow-mvp`
**Mode:** READ-ONLY

> **SCOPE NOTE.** `git log` shows the work lives on a topic branch
> (`feat/auto-process-pipeline`), not `main`. `main` (HEAD `097d348`) ships
> **only the test suite** — the commit message itself admits
> *"the production code that they exercise was never written"*. The SSE
> controller, processing-service lock logic, frontend ProcessingStatus,
> auto-approve toggle, `tenants/me/settings` endpoint, schema migration,
> and module wiring all live on `feat/auto-process-pipeline`. **This
> audit grades the topic branch, which is the deliverable.**

---

## 0. Methodology + scoping decisions

Per the briefing checklist (14 surfaces), every item was probed against the
topic branch. The verification was:

- `git log` ancestry + commit-by-commit diff against `main`.
- Full read of the 8 critical files (substituting the topic-branch
  versions for files that don't exist on `main`).
- `npx tsc --noEmit` on `apps/api` (main branch): **13 pre-existing
  errors, 0 new from Sprint H**.
- `npx jest src/modules/documents/processing src/common/queue`: **6/6
  suites pass, 39/39 tests green** (unit-level — confirms shape, not
  production wiring).
- Static inspection of the SSE controller, processing.service, queue
  adapters, and frontend ProcessingStatus component.

Findings are ranked most-severe first. BLOCKERs (anything that would let a
cross-tenant read or that hard-fails the pipeline in production) are
called out at the top.

---

## BLOCKER

### B-1. SSE endpoint BOLA bypass when `req.user.tenantId` is undefined
**File:** `apps/api/src/modules/documents/processing/processing.controller.ts` L84–108
**Severity:** BLOCKER (cross-tenant info leak in any deployment where
the TenantMiddleware has not populated `req.user.tenantId` before the
controller runs)

```typescript
const user = (req as any).user;
const tenantId: string | undefined =
  (user && (user.tenantId ?? user.tenant_id)) || undefined;

if (tenantId) {
  this.prisma.document.findFirst({ where: { id, tenantId }, ... })
    .then((row) => {
      if (!row && !res.headersSent) res.status(404).end();
    });
}
// ... then sets SSE headers and calls this.events.stream(id) UNCONDITIONALLY
```

**Issue.** When `tenantId` is undefined (test harness, missing
TenantMiddleware binding, or a future middleware reorder) the controller
**skips the BOLA check entirely** and opens the SSE stream for any
`documentId`. The events-store `stream(id)` factory creates a fresh
`Subject` in the in-memory map for ANY id, so the attacker can:

1. Connect SSE for `docId="some-other-tenant's-uuid"`.
2. Trigger pipeline activity by re-publishing to the queue (or wait for
   the legitimate tenant's pipeline).
3. Receive the other tenant's `processing.stage.completed` /
   `processing.completed` events.

The comment *"the events store has no entries for non-existent docs
anyway"* is wrong — the `stream()` factory eagerly creates a Subject,
so a new id always succeeds. The findFirst is **the only tenant gate**,
and it's skipped.

**Fix.** Make the tenant check mandatory. If `tenantId` is undefined the
controller should `res.status(401).end()` (or throw
`UnauthorizedException`) — never proceed to `events.stream()`. The
cleanest version is a NestJS guard that throws before the handler
executes.

---

## HIGH

### H-1. No per-`documentId` SSE connection cap (DoS amplification)
**File:** `apps/api/src/modules/documents/processing/processing.controller.ts` L72–110 + `processing-events-store.service.ts` L33 (`MAX_CONCURRENT_DOCS = 1000`)
**Severity:** HIGH (OWASP API4 — Unrestricted Resource Consumption)

The scout report and controller comments claim *"5 connections / tenant+docId"*,
but **the controller never enforces this**. There is no
`Map<documentId, number>` connection counter, no `@Throttle` decorator on
`stream()`, and the only ceiling is the global `MAX_CONCURRENT_DOCS = 1000`
on the events-store. A single attacker can hold up to 100 SSE connections
across any tenant boundary (subject only to the global throttler of
100/60s per tenant). With 1000+ tenants this is a one-shot DoS vector
that fills the events-store map and triggers the LRU `evictIfOverCap()`
branch — silently dropping real subscribers on completed docs.

**Fix.** Add a `connectionsByDoc` counter in `ProcessingEventsStore`. On
`stream()`:
- If `connectionsByDoc.get(id) >= MAX_PER_DOC (e.g. 5)`, `res.status(429).end()`.
- On `req.on('close')`, decrement.

Also `@Throttle({ name: 'sse-stream', ... })` per-IP to bound total
connections per network.

### H-2. Pipeline-branch has **no migration SQL** for `processingAttempt`
**Files:** `apps/api/prisma/schema.prisma` L462 vs. `apps/api/prisma/migrations/20260905000000_add_processing_status/migration.sql`
**Severity:** HIGH (build/runtime break)

`schema.prisma` declares `processingAttempt Int @default(0)` but the
migration **does not create the column**. `prisma migrate dev` on a fresh
DB will succeed (because the migration just adds the columns it lists),
but the Prisma client will generate a `processingAttempt` accessor that
fails at runtime when any code reads/writes it. `prisma generate` will
happily type the field; the runtime error only appears on first use.

**Fix.** Add `ADD COLUMN "processingAttempt" INTEGER NOT NULL DEFAULT 0`
to the migration OR remove the column from the schema if it's unused.

### H-3. EventSource cannot carry `Authorization: Bearer` — SSE will 401 in production
**Files:**
- `apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx` L99–124 (new EventSource)
- `apps/api/src/modules/documents/processing/processing.controller.ts` L70 (`@Sse('stream')` under JwtGuard)
**Severity:** HIGH (functional break + mitigates B-1 if attacker uses `credentials: include` against cookie auth that wasn't bound to a JWT-protected route)

```js
const es = new EventSource(`/api/v1/documents/${id}/processing/stream`, {
  withCredentials: true,
});
```

Native `EventSource` **does not support custom request headers**, so the
JWT in `Authorization` is never sent. The `credentials: include` only
works for cookie auth — which DocFlow does not use (JWT-only).

The SSE endpoint is protected by the global `JwtGuard` (L156 of
`app.module.ts`), so the EventSource connection will return **401**.
The 3-second timeout in `processing-status.tsx` L128 falls back to
polling — and `fetchStatus` also relies on `credentials: 'include'`
(L83), which also fails for JWT. **End result: zero progress shown to
the user, SSE endpoint reaches a 401 every 3s.**

The scout report flagged this as Risk #7 (HIGH) and proposed a
cookie-based SSE auth OR a polling-only fallback. Neither was
implemented.

**Fix.** Either (a) read the JWT from a cookie set by the API after
login and use `withCredentials: true` against that cookie, or (b) keep
SSE-only for `?token=` query-param support and drop the `JwtGuard` on
the SSE route via a custom guard that validates the query param with
`timingSafeEqual` (Stripe-style), or (c) ship the polling fallback as
the primary path with header-based auth.

### H-4. `autoApprove` PATCH endpoint does not exist; `AutoApproveToggle` silently fails
**Files:**
- `apps/web/app/(dashboard)/settings/_components/auto-approve-toggle.tsx` L46–53
- (no backend `tenants/` module / controller / service anywhere on the branch)
**Severity:** HIGH (functional break — not strictly a security finding
but downstream effect: no audit row written when the user thinks they
toggled auto-approve; worse, an admin might believe auto-approve is OFF
when it is actually still defaulting on by tenant settings elsewhere)

The frontend hits `PATCH /api/v1/tenants/me/settings` with
`{ autoApprove: true|false }`. There is **no `tenants/` module** on the
pipeline branch (verified via `git ls-tree -r feat/auto-process-pipeline
--name-only | grep tenants`). The call will return **404**. The toggle's
optimistic update will be reverted by its own rollback branch on 404
(L67) — but a malicious user who can intercept the response could
spoof a 2xx and leave the UI showing "enabled" while the backend never
recorded it.

Even if a `tenants/` module existed, **mass-assignment protection** is
needed: the PATCH body should be a typed DTO with `@IsBoolean() autoApprove`
+ ValidationPipe `whitelist: true, forbidNonWhitelisted: true` —
otherwise a future `{ autoApprove: true, id: 'other-tenant', role: 'OWNER' }`
body becomes a privilege escalation. (oc-api-audit §3.)

**Fix.** Build the `tenants/` module + `PATCH /tenants/me/settings`
endpoint with a typed DTO (`UpdateTenantSettingsDto { autoApprove:
boolean }`) guarded by `@Roles('ADMIN','OWNER')` and the global
`RbacGuard`. Add an audit row with `action: AuditAction.EDIT` and
`subAction: 'tenant.settings.autoApprove'`.

### H-5. `processing.service` publishes through a static accessor — broken across module instances
**File:** `apps/api/src/modules/documents/processing/processing.service.ts` (pipeline branch) — uses `ProcessingService.publishEvent(...)` and `ProcessingService.setQueueRef(...)` static methods
**Severity:** HIGH (functional break that masks audit-log gaps)

The service stores the `QueueAdapter` reference in a **module-static
field** (`ProcessingService.setQueueRef(this.queue)` in
`processing.module.ts`). In a multi-tenant deployment with multiple
Nest app instances (PM2 cluster mode, multiple pods), each instance has
its own static, so an event published from app-A to its static adapter
will only be re-emitted to app-A's local subscribers — not to the SSE
clients connected to app-B. The 4-stage pipeline therefore appears
"stuck" to operators watching one pod while events flow on another.

Even more concerning: a publish failure inside `publishEvent()` falls
through silently — the `tryHandler` catches errors and marks the doc
FAILED with the truncated message, but the failure is **not** logged at
ERROR level, so a single-pod incident goes undiagnosed.

**Fix.** Inject `QueueAdapter` into `ProcessingService` directly (this
requires extracting the typed event payloads to a shared file
`processing-events.ts`, which the pipeline branch has already done at
L11–14 of `processing.service.ts`). Remove the static accessor pattern.

---

## MEDIUM

### M-1. Audit row uses `AuditAction.EDIT` with `subAction: 'processing.X'` — no enum coverage
**Files:**
- `apps/api/src/modules/documents/processing/processing.service.ts` (pipeline branch) L78–92, L120–124, L210–214, L394–399
- `apps/api/prisma/schema.prisma` L132–150 (existing `AuditAction` enum)
**Severity:** MEDIUM (oc-api-audit §9 — Audit Log Coverage)

Per the scout report, the new pipeline events log via `AuditAction.EDIT`
with `metadata.subAction: 'processing.started' | 'processing.stage.advanced'
| 'processing.enriched' | 'processing.routing' | 'processing.completed'
| 'processing.failed'`. This is consistent with the Sprint E
`tenant.settings.update` pattern and avoids a migration.

However, the `autoApprove` toggle (H-4) does NOT have a matching audit
row. When the toggle eventually ships, the backend must emit
`AuditAction.EDIT` with `subAction: 'tenant.settings.autoApprove'` —
without it, the toggle is a privileged action that leaves no forensic
trail.

**Fix.** Document the audit pattern in `audit-action.enum.ts` (or its
Prisma equivalent) — explicitly enumerate `processing.*` and
`tenant.settings.*` subAction values. Add a unit test that asserts each
stage transition produces exactly one row.

### M-2. `events-store` keeps an unbounded `Map<docId, Subject>` in memory
**File:** `apps/api/src/modules/documents/processing/processing-events-store.service.ts` L33 (`MAX_CONCURRENT_DOCS = 1000`)
**Severity:** MEDIUM (cross-pod DoS via memory growth)

The cap is per-instance, not cluster-wide. With 3 pods and 1,000 docs
each, that's 3,000 subscribers + Subjects in flight — about 10 MB of
hot memory per pod. A burst that evicts the oldest 1,000 entries on
each pod means real subscribers on long-running docs lose their
connection mid-pipeline. The eviction log message is at debug level
(grep), so operators don't notice.

**Fix.** Reduce the cap to 250 (matches realistic concurrent docs per
pod), emit a metric on every eviction, and switch the eviction policy
from FIFO to LRU if it's not already (the L29 comment says "Map
iteration order is insertion order — drop the oldest", which is FIFO,
not LRU — confirm intended).

### M-3. `pg_advisory_xact_lock` key collision risk with `relocateAfterApprove`
**Files:**
- `apps/api/src/modules/documents/processing/processing.service.ts` (pipeline branch) — `docLockKey()` computes a hash per documentId
- `apps/api/src/modules/documents/documents.service.ts` (existing `relocateAfterApprove`) — uses its own advisory lock for the same docId
**Severity:** MEDIUM (oc-api-audit §12 — Race Conditions)

The scout report (Risk #12) claims *"Stage 3 (routing) calls
approve() which PÓS acquires the MESMO lock — order is consistent.
`docLockKey()` is determinístico (hash SHA-256 truncated). Sem
deadlock."* But the two lock-key derivations need to be **identical**
for this to hold:

- `relocateAfterApprove` (existing): `pg_advisory_xact_lock(hashtext('relocate:' || documentId))`.
- `ProcessingService.docLockKey()` (new): SHA-256 truncated, encoded
  differently.

Two locks using different keys for the same docId do **not** serialize.
The pipeline's auto-approve call into `documentsService.approve()` can
race against a manual `approve()` from the UI button — both will try to
relocate the file and the second wins. If the first already moved the
bytes, the second's `move()` will hit `ENOENT` (handled: returns as
no-op in `local-filesystem.storage.ts` L132) — but the audit trail will
show two `APPROVE` rows for the same doc with conflicting actor IDs.

**Fix.** Centralize the lock-key derivation in `common/locks.ts` and
have both `documents.service.ts` and `processing.service.ts` import
the same `docLockKey(id)`.

### M-4. SSE emits `fileKey` and `partyId` to all subscribers on the same doc
**File:** `apps/api/src/modules/documents/processing/processing.controller.ts` (pipeline branch) — `stream()` returns raw event payloads
**Severity:** MEDIUM (oc-api-audit §13 — Information Disclosure)

The processing service emits payloads with `fileKey`, `partyId`, and
`approved` boolean to all SSE subscribers. While the SSE endpoint is
BOLA-gated per-documentId, the `tenant.events` are stored in a Map
keyed by documentId only — the Subject is shared. Two subscribers
on the same document (legitimate UX case: detail page + inbox badge)
both see the same data. The risk is acceptable for the same-tenant
case.

However, if **H-1 is ever exploited** (1000-doc cap evicting legitimate
subscribers, then a new SSE connection re-subscribes to a Subject that
already holds the previous tenant's events in its replay buffer),
the new connection sees stale events. The fix is to use a `ReplaySubject(0)`
(no replay) — the `processing-events-store.service.ts` L60 already does
this correctly (`new Subject<...>()` not `new ReplaySubject(...)`).
**PASS on this dimension**; the residual risk is only via H-1.

### M-5. `LocalFilesystemStorage.move()` ENOENT fallback can mask failures
**File:** `apps/api/src/modules/documents/storage/local-filesystem.storage.ts` L130–132
**Severity:** MEDIUM (oc-api-audit §11)

The `move()` helper treats `ENOENT` at the source as idempotent
no-op. If a relocator race deletes the source between
`documents.approve()`'s SELECT and the `move()` call, the bytes are
gone and the audit row says "APPROVED" — but the tenant has no file.
The pipeline's auto-approve path goes through the same code; if
auto-approve fires while a manual approve is mid-relocate, the second
move silently succeeds (ENOENT) and the doc has no bytes.

**Fix.** At minimum, log a WARN-level message when the ENOENT branch
fires — currently L131 silently `return`s.

### M-6. SSE has no `@Roles` decorator — relies on global guards
**File:** `apps/api/src/modules/documents/processing/processing.controller.ts` (pipeline branch)
**Severity:** LOW–MEDIUM (oc-api-audit §2 — BFLA)

The SSE controller has no `@Roles(...)` decorator. Auth flows through
the global `JwtGuard + TenantGuard + RbacGuard` stack (per `app.module.ts`
L155–159). For a READ endpoint this is acceptable (any authenticated
tenant member can read pipeline status for a doc they have access to).
Document this intent with a comment on the controller class to make the
design choice explicit.

---

## LOW

### L-1. `bullmq.adapter.ts` lazyConnect swallows Redis-down on boot
**File:** `apps/api/src/common/queue/bullmq.adapter.ts` (pipeline branch) — `this.connection.connect().catch(...)` at boot
**Severity:** LOW (operational)

The boot handler logs a WARN if Redis is down but does not mark the
adapter unhealthy. Operators should be paged on this log line.

### L-2. Frontend `processing-status.tsx` does not escape `view.error`
**File:** `apps/web/app/(dashboard)/documents/[id]/_components/processing-status.tsx` L286, L302
**Severity:** LOW

The component renders `{view.error.slice(0, 80)}` inside a JSX `<span>`.
React auto-escapes text nodes, so this is **safe against stored XSS**.
The `slice(0, 80)` truncation is consistent with the backend's
`processingError` cap of 500 chars (`processing.service.ts` L412).
PASS — but a future maintainer who refactors this into a `dangerouslySetInnerHTML`
will open XSS. Add a JSDoc warning.

### L-3. `processing-service` test mocks bypass `pg_advisory_xact_lock`
**Files:** `apps/api/src/modules/documents/processing/__tests__/processing-pipeline.spec.ts`
**Severity:** LOW (test-coverage)

The 39 unit tests mock `$executeRaw` to return `undefined`. Production
runs `SELECT pg_advisory_xact_lock(...)`. There's no integration test
that verifies the lock actually serializes concurrent handlers (see
M-3 — without an integration test, the lock-key mismatch won't surface
until production). Recommend one pg-integration spec that fires two
`handleReceived` calls in parallel and asserts only one advances the
doc.

### L-4. BullMQ Redis connection is not authenticated
**File:** `apps/api/src/common/queue/bullmq.adapter.ts` L127–134 (pipeline branch)
**Severity:** LOW (oc-api-audit §12)

`buildConnection()` reads only `REDIS_HOST` and `REDIS_PORT`. No
`REDIS_PASSWORD`, no `REDIS_USERNAME`, no `REDIS_TLS`. Production
Redis should be locked down. Same issue applies to the `BullModule.forRootAsync`
factory in `app.module.ts` L97–99 (pre-existing).

### L-5. Frontend XSS audit on `AutoApproveToggle`
**File:** `apps/web/app/(dashboard)/settings/_components/auto-approve-toggle.tsx`
**Severity:** LOW

The component renders `initial` as a `<Switch>` state — no string
injection. PASS. However, when the toggle eventually succeeds against
a real backend, the toast message comes from a static string literal,
not from server data — safe.

---

## PASS findings (no issues)

- **§1 BOLA in `documents.service.upload()`** (pipeline branch L290–310) — the upload now publishes `document.received` and writes the pipeline audit row inside a transaction. TenantId from the auth context, not the request body. PASS.
- **§6 Security Misconfiguration — Storage factory** (pipeline branch) — `STORAGE_DRIVER` env is read once at boot, unknown values fall back to `local` with a loud log. S3/MinIO/Supabase stubs throw with a clear "not implemented" message. PASS.
- **§6 — CORS / Helmet** — pre-existing (Sprint D), unchanged in Sprint H. PASS.
- **§7 Improper Inventory Management** — no new `@Public()` decorator on the SSE endpoint. Auth required. PASS.
- **§8 Input Validation** — DTOs untouched (no new body DTOs introduced; the SSE endpoint takes only `@Param('id')`). PASS.
- **§9 Audit Log on success** — every stage transition writes an audit row (`processing.started`, `processing.stage.advanced`, `processing.enriched`, `processing.routing`, `processing.completed`, `processing.failed`). Actor is the original `userId` for stage 1; system reuses `userId` for stages 2-4 (no `'system'` actor — the audit row is attributed to the human who triggered the pipeline, not the pipeline itself; this is a design choice, not a defect). PASS.
- **§11 File System Security** — `LocalFilesystemStorage.resolveSafe()` unchanged (Sprint E hardening holds). `move()` cross-volume fallback already in place. PASS.
- **§13 Information Disclosure** — `processingEventsStore.stream(id)` returns a hot Subject (no replay), so late subscribers cannot read past events from other tenants. PASS.
- **§1 BOLA in `processing.controller.ts:status()`** — second `findFirst` includes `tenantId` in `where`. PASS.
- **Frontend XSS on `processing-status.tsx`** — React auto-escapes; no `dangerouslySetInnerHTML` in the component. PASS.

---

## Summary table

| ID | Severity | Surface | File | Status |
|---|---|---|---|---|
| B-1 | BLOCKER | BOLA (OWASP API1) | processing.controller.ts:84–108 | open |
| H-1 | HIGH | Resource Consumption (API4) | processing.controller.ts + events-store | open |
| H-2 | HIGH | Schema drift / build break | migration.sql | open |
| H-3 | HIGH | Functional break — auth/SSE | processing-status.tsx + processing.controller.ts | open |
| H-4 | HIGH | Missing endpoint + future Mass Assignment risk | auto-approve-toggle.tsx + (no tenants module) | open |
| H-5 | HIGH | Functional break (static accessor) | processing.service.ts | open |
| M-1 | MEDIUM | Audit coverage | processing.service.ts + audit-action.enum.ts | open |
| M-2 | MEDIUM | DoS via memory growth | processing-events-store.service.ts | open |
| M-3 | MEDIUM | Race condition — lock-key mismatch | processing.service.ts + documents.service.ts | open |
| M-4 | MEDIUM | Info disclosure (residual via H-1) | processing.controller.ts | info-only |
| M-5 | MEDIUM | File-system race | local-filesystem.storage.ts:130 | open |
| M-6 | LOW | BFLA — no @Roles on SSE | processing.controller.ts | advisory |
| L-1 | LOW | Operational | bullmq.adapter.ts | advisory |
| L-2 | LOW | Future XSS risk | processing-status.tsx | advisory |
| L-3 | LOW | Test coverage | processing-pipeline.spec.ts | advisory |
| L-4 | LOW | Redis auth | bullmq.adapter.ts + app.module.ts | advisory |
| L-5 | LOW | XSS audit | auto-approve-toggle.tsx | PASS |

---

## Verdict

**NEEDS FIX.** One BLOCKER (B-1) and five HIGH (H-1 through H-5) findings
must be resolved before this can ship to production. The BLOCKER (B-1)
is a single-line fix — make the tenant check unconditional — but H-2,
H-3, H-4, and H-5 each require non-trivial work (a new migration column,
an SSE-auth strategy decision, a brand-new `tenants/` module, and a DI
refactor respectively).

---

## Tests required

1. **Integration spec:** `processing-pipeline.integration.spec.ts` —
   spin up a real pg + a real Redis (testcontainers or docker-compose),
   fire two `handleReceived` calls in parallel, assert only one advances
   the doc (covers B-1 indirectly and M-3 directly).
2. **BOLA test:** `processing-sse-bola.spec.ts` — call
   `GET /documents/<other-tenant-uuid>/processing/stream` without a JWT
   and assert 401, then with a tenant-A JWT and a tenant-B docId and
   assert 404 (the controller must NOT open the SSE stream).
3. **SSE cap test:** `processing-sse-cap.spec.ts` — open 6 SSE
   connections against the same documentId from the same tenant and
   assert the 6th returns 429.
4. **Migration test:** a script that runs `prisma migrate reset` on a
   throwaway DB and then queries `documents.processingAttempt` — must
   not throw. Currently it does (H-2).
5. **Audit-trail test:** `processing-audit-coverage.spec.ts` — assert
   each stage transition produces exactly one `AuditAction.EDIT` row
   with the expected `subAction`.

---

*End of SECURITY-AUDIT-REPORT.md*
