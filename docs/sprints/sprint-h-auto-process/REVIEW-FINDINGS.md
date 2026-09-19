# Sprint H — REVIEW FINDINGS (CODE-REVIEWER, Opus 5)

**Branch:** main · **HEAD:** 097d348 (Sprint H processing pipeline tests passing)
**Working dir:** `C:\Projetos\docflow-mvp`
**Mode:** READ-ONLY · **Skill loaded:** `oc-api-audit` (§1-13 applied)
**Verdict:** **NEEDS FIX** — pipeline core is sound in isolation, but 5 of the 7 promised deliverables are unwired end-to-end. Pipeline cannot run in production as shipped.

---

## Summary table

| # | Finding | Severity | OWASP / Checklist ref | DocFlow evidence |
|---|---|---|---|---|
| 1 | **Pipeline is not triggered** — `DocumentsService.upload()` never publishes `document.uploaded`; ProcessingService is never subscribed to the QueueAdapter | BLOCKER | Sprint H §3 touchpoint #14, §11.7 wiring | `documents.service.ts:294` (calls `extraction.enqueue` directly); `processing.service.ts:125` (`queue?` is `@Optional`, never injected); `documents.module.ts:27` (no ProcessingModule); `app.module.ts:131` (no QueueModule.forRoot/ProcessingModule) |
| 2 | **No SSE controller** — `/documents/:id/processing/stream` endpoint missing entirely | BLOCKER | Sprint H §5 backend, §7 #1 frontend | `documents.controller.ts` has no `@Get(':id/processing/stream')`; no `processing.controller.ts` exists anywhere under `src/modules/documents/processing/` |
| 3 | **No frontend `ProcessingStatus` component / no `AutoApproveToggle`** | BLOCKER | Sprint H §7 #1, SCOUT §1.7 | `apps/web/app/(dashboard)/documents/[id]/_components/` lists only `document-viewer/field-panel/fraud-warning/qr-badge` — no `processing-status.tsx`; no `auto-approve` toggle file in `apps/web` |
| 4 | **`processingStatus` is NEVER seeded on upload** — handler `handleReceived` assumes RECEIVED but DocumentsService.upload doesn't `prisma.document.update({ processingStatus: 'RECEIVED' })` before publish | HIGH | §10 idempotency, §12 race | `documents.service.ts:213-238` (insert lacks `processingStatus: RECEIVED`); `processing.service.ts:152` (idempotency guard `processingStatus !== RECEIVED` skips docs with `null`) |
| 5 | **Race condition** — handler runs WITHOUT `pg_advisory_xact_lock(documentLockKey(documentId))`. SCOUT §1.8 §12 called this out as required. | HIGH | oc-api-audit §12 race conditions | `processing.service.ts:145,200,250,322` (transactions have NO lock); SCOUT §1.8: "Pipeline stages também precisam lock POR documentId" |
| 6 | **EventEmitter subscribeBatch receives ONE handler for all 4 topics** — when any stage is a no-op (idempotent skip), the SSE event is still emitted for the OTHER 3 stages because `dispatch()` always emits when `updated=true`, but if all 4 skip silently the SSE stream stays open forever (no terminal event) | HIGH | §10 idempotency, §3 SSE | `processing.service.ts:131-134` (single batch handler), `processing-events-store.service.ts:76-78` (terminal events close the Subject — non-terminal skip path leaves SSE hanging) |
| 7 | **`processing.completed` event never reaches subscriber if doc was already at COMPLETED before handleRouted** — idempotent re-publish of `document.routed` is silently dropped at `processing.service.ts:325-329`, so SSE clients waiting for terminal event wait forever | HIGH | §10 idempotency, frontend UX | `processing.service.ts:325-330` (early return on `processingStatus !== ROUTING`) — caller has no way to know it's a duplicate; no `processing.completed` replay; SSE subscriber's `complete()` never fires for the duplicate case |
| 8 | **`prisma.document.findFirst` has NO `tenantId` filter** in 3 of 4 handlers — BOLA / cross-tenant read | HIGH | oc-api-audit §1 BOLA, Sprint H §1.8 §1 BOLA | `processing.service.ts:146, 201, 251, 323, 470, 484` (all `where: { id: documentId }` only) — a forged `document.uploaded` event for another tenant's documentId will be acted on |
| 9 | **`approval` audit row missing** — when `documents.approve()` runs from `handleEnriched`, no audit row is written by ProcessingService (only `processing.stage.advanced` is logged); `approve()` itself does write one but the ProcessingService layer has no direct visibility for forensic trail correlation | MEDIUM | oc-api-audit §9 audit | `processing.service.ts:265-272` (writes `processing.stage.advanced` only, not `processing.auto_approved` even when autoApprove fired) |
| 10 | **`extraction.enqueue()` called INSIDE the txn-protected handler** — no await guard around side-effect; if enqueue throws AFTER the txn commits, `tryHandler` marks doc FAILED on the next iteration, but the txn already set EXTRACTING | MEDIUM | §10 idempotency | `processing.service.ts:187-191` (enqueue is OUTSIDE the `$transaction` closure at line 145, which is good — but `tryHandler` runs at line 192, so a throw from enqueue flips the doc to FAILED AFTER EXTRACTING was already persisted) |
| 11 | **`QueueModule.forRoot()` never called** — module is global-with-factory but app.module.ts has no `QueueModule.forRoot()` import | HIGH | Sprint H §3 #7 | `app.module.ts:50-151` (no `QueueModule.forRoot()` line) |
| 12 | **`ProcessingModule` never imported** — neither `app.module.ts` nor `documents.module.ts` imports it; service is never constructed in production | HIGH | Sprint H §3 #13, §3 #16 | `app.module.ts:131-150` (no ProcessingModule); `documents.module.ts:27` (no ProcessingModule in `imports`) |
| 13 | **`StorageService` enum missing `supabase`** — interface declares `'local' \| 's3' \| 'minio'`; SCOUT §2.2 said `supabase` was the target | MEDIUM | Sprint H decision 2.2, scope creep risk | `storage-service.interface.ts:74` |
| 14 | **`getSignedUrl` returns a RELATIVE PATH, not a presigned URL** — `local-filesystem.storage.ts:156` returns `/api/v1/documents/storage/<encoded key>`. The encoded key includes the full tenantId path; the route `documents.controller.ts:269` `GET :id/download` is the real download, not `documents/storage/:key`. The returned URL is a phantom route. | MEDIUM | oc-api-audit §13 information disclosure (URL leaks tenantId in path) | `local-filesystem.storage.ts:151-157`; the suggested route `/api/v1/documents/storage/<key>` is NOT registered in `documents.controller.ts` |
| 15 | **`@Optional() private readonly queue?: QueueAdapter`** in ProcessingService constructor — makes the queue opt-in for tests; in production this is supplied ONLY if ProcessingModule's QueueModule is wired (and it isn't per finding #11). Production wiring is structurally broken. | HIGH | Sprint H §3 #13, deployability | `processing.service.ts:125` |
| 16 | **`processingStatus` enum exists in schema but no migration added it** — running `prisma migrate status` in any fresh env will fail to generate the Prisma client correctly; `processingStatus` field already in `schema.prisma:458` but the migration that adds the enum type + column is missing from `apps/api/prisma/migrations/` (latest: `20260904000003_add_party_contacts_addresses`) | HIGH | §11 storage / schema, deployability | `schema.prisma:68, 458-461`; `migrations/` ends at `20260904000003` (no `*_add_processing_status*`); `Document` model has columns but no migration |
| 17 | **DLQ is "audit row only" but `processing.failed` audit row is also missing** — `tryHandler` writes `audit.logInTx({ subAction: 'processing.failed' })`, so DLQ-as-audit-log is actually present; flag this as RESOLVED. | INFO | §10 failure recovery | `processing.service.ts:428-439` ✓ |
| 18 | **No `keepalive` comment emission** for SSE — proxy / LB timeouts will kill idle connections; ProcessingEventsStore subjects only emit on actual stage events, no heartbeat | HIGH | §3 SSE, Sprint H §5 backend | `processing-events-store.service.ts` (no periodic emit); no controller file means nothing flushes a keepalive |
| 19 | **No throttle on `/documents/:id/processing/stream`** — `@Throttle` decorator absent (no controller at all); per-tenant SSE flood possible | MEDIUM | oc-api-audit §4 unrestricted consumption | no `processing.controller.ts` exists |
| 20 | **No tests for cross-tenant `document.uploaded` injection** — pipeline tests construct `FakePrisma` that always returns the doc regardless of tenant; the production code in `processing.service.ts:146` does `findFirst({ where: { id: documentId } })` with NO tenantId filter, but no test asserts the filter is present | HIGH | oc-api-audit §1 BOLA, test coverage gap | `__tests__/processing-pipeline.spec.ts:44-46` (findFirst mock returns doc for any id, no tenantId check) |

---

## Findings by checklist item (A-L)

| Checklist | Status | Evidence |
|---|---|---|
| **A. Pipeline idempotência** | **FAIL** | See findings #4, #6, #7. The `processingStatus !== RECEIVED` guard exists but only AFTER a no-op `findFirst` (no tenantId, no lock). Re-publish of `document.routed` after COMPLETED silently drops the SSE terminal event (#7). |
| **B. Failure recovery** | PARTIAL | See finding #17 (audit log row ✓), but no DLQ worker, no admin UI, no retry policy for the actual extraction job (that's delegated to existing `extraction.service.ts` retry path). |
| **C. SSE endpoint** | **FAIL** | No `processing.controller.ts` exists (finding #2). No `keepalive` mechanism (#18). No throttle (#19). |
| **D. Storage adapter** | PARTIAL | `LocalFilesystemStorage` correctly implements interface ✓; `move()` has cross-volume fallback ✓; but `getSignedUrl()` returns a phantom route (#14); no factory/S3/Supabase driver (#13). |
| **E. Queue adapter** | PARTIAL | BullMQ retry/backoff correct (3 attempts, exponential); `isDedupError` swallows jobId duplicates. But module never wired into app.module (#11). EventEmitterAdapter fallback works in isolation. |
| **F. autoApprove** | **FAIL** | `handleEnriched` reads `tenant.settings.autoApprove` correctly (L287). **But** (i) it's never set to false at tenant creation → if Tenant row has `settings: null`, `settings?.autoApprove === true` returns false (safe-default), so this is actually OK; (ii) UI toggle not shipped (#3); (iii) no race protection if settings flip mid-pipeline (read happens in `handleEnriched` between updates — benign but worth flagging). |
| **G. Tenant isolation** | **FAIL** | See finding #8. All 4 `findFirst` calls in `processing.service.ts` lack `tenantId`. A forged event with another tenant's documentId would advance the pipeline. BOLA exposure. |
| **H. Audit log** | PARTIAL | Each stage transition writes a row ✓. `subAction` values used: `processing.started`, `processing.stage.advanced`, `processing.completed`, `processing.failed` ✓. But `subAction: 'processing.auto_approved'` is MISSING when autoApprove fires (#9). |
| **I. Frontend UX** | **FAIL** | Component doesn't exist (#3). Cannot review reconnect logic, EventSource cleanup, unmount safety. |
| **J. Stage transitions** | PASS | Tests in `processing-status-transitions.spec.ts` confirm `RECEIVED→EXTRACTING→ENRICHING→ROUTING→COMPLETED` order. `FAILED` is terminal (idempotent skip confirmed). |
| **K. Tests** | PARTIAL | 4 spec files / 47 tests written; pipeline behaviour is well-covered in isolation. But: cross-tenant not tested (#20), SSE endpoint not tested (no endpoint), retry/backoff not tested for EventEmitter, storage driver factory not tested (no factory). |
| **L. Retrocompatibilidade** | PASS | Schema marks `processingStatus` as nullable (`DocumentProcessingStatus?`); handler's `findFirst` returns `processingStatus: null` which the idempotency guard treats as `!== RECEIVED` → skip → safe. New docs without `processingStatus: RECEIVED` set (#4) means they don't trigger, but they also don't crash. |

---

## BLOCKERs (must fix before merge)

1. **Wire `QueueModule.forRoot()` + `ProcessingModule` into `app.module.ts`**, and import `ProcessingModule` into `DocumentsModule` so `DocumentsService` can publish `document.uploaded`. Without this, zero pipeline traffic flows in production — only the test suite exercises the handlers directly.
2. **Add `processing.controller.ts`** with `@Sse('stream')` route reading from `ProcessingEventsStore.stream(documentId)` via `@MessagePattern`-equivalent (use `rxjs` Subject directly), with tenant filter (BOLA), 20s keepalive comment, and `@Throttle({...})` on the route.
3. **Add frontend `ProcessingStatus.tsx`** with `EventSource` subscription + reconnect-on-error + cleanup-on-unmount (return of `useEffect` must `eventSource.close()`).
4. **In `DocumentsService.upload()`, set `processingStatus: 'RECEIVED'`** on the created Document AND publish `document.uploaded` to the queue — currently the doc is created with `processingStatus: null` and `extraction.enqueue` is called directly, bypassing the new pipeline entirely.
5. **Add `tenantId` filter to all 4 `findFirst` calls** in `processing.service.ts` — change to `where: { id: documentId, tenantId: evt.tenantId }`. Add a regression test asserting cross-tenant injection is refused.

## HIGHs (should fix in same sprint)

6. **Add `pg_advisory_xact_lock`** at the start of each handler transaction — currently the read-modify-write cycle is racy.
7. **Replay terminal events on idempotent skip** — when `handleRouted` finds doc already COMPLETED, emit `processing.completed` to the SSE stream anyway so late subscribers see the terminal event.
8. **Emit `:keepalive\n\n` SSE comment every 20s** — implement in `ProcessingEventsStore` (rxjs `interval(20_000).pipe(map(() => ({ event: ':keepalive', ... })))`) or in the controller.
9. **Emit `processing.auto_approved` audit row** when `handleEnriched` actually calls `documents.approve()` (separate from `processing.stage.advanced`).
10. **Add migration for `DocumentProcessingStatus` enum + columns** — schema declares it but migrations dir ends at `20260904000003`. Fresh `prisma migrate deploy` will fail to apply.

## MEDIUMs (nice-to-have before merge)

11. **Fix `getSignedUrl` phantom route** — return the actual `/documents/:id/download` URL pattern the controller exposes (or `null` for local + log warning).
12. **Add `supabase` to `StorageService` driver enum** — even as a stub, satisfies SCOUT commitment.
13. **Throttle SSE route** — `@Throttle({ 'master-write': { ttl: 60000, limit: 5 } })` keyed by tenant+doc.

---

## What's PASS

- ✓ `EventEmitterAdapter` correctly wraps `eventemitter2` (CJS-resilient), handler errors isolated
- ✓ `BullmqAdapter` dedup via deterministic `jobId = sha256(topic + payload).slice(0,24)` — same payload same id, idempotent at queue layer
- ✓ `ProcessingEventsStore` Subject-per-doc, hard cap 1000, terminal events `complete()` the Subject, `onModuleDestroy` cleanup
- ✓ `LocalFilesystemStorage.move()` has cross-volume rename fallback + size verification + partial-cleanup
- ✓ `LocalFilesystemStorage.resolveSafe()` rejects `..`, absolute paths, NUL bytes, root-escape
- ✓ `tryHandler` catches all errors, writes FAILED + audit row + SSE failure event atomically
- ✓ Idempotency guard in every handler: `processingStatus !== expected → skip`
- ✓ Auto-approve gate requires BOTH `tenant.settings.autoApprove === true` AND `partyId !== null` — refuses to auto-approve unattributed docs
- ✓ Approved failure in `handleEnriched` is captured (`approveError`) and surfaced via SSE without poisoning the pipeline
- ✓ Tests cover: 4-stage transitions, FAILED terminal, idempotent retry, autoApprove true/false × partyId present/missing, approve() failure isolation, SSE broadcaster unit, eviction cap

---

## Verdict

**NEEDS FIX — 5 BLOCKER, 5 HIGH, 3 MEDIUM.**

The pipeline kernel (ProcessingService + ProcessingEventsStore + QueueAdapters) is well-designed and well-tested in isolation. The wiring layer (app.module, documents.module, documents.service.upload, processing.controller, ProcessingStatus.tsx) is unfinished. As committed, the pipeline will not run in production — `documents.upload()` does not publish `document.uploaded`, no SSE endpoint exists, no frontend consumes it, and the BOLA hole in the handler `findFirst` calls is exploitable.

After the 5 BLOCKER fixes, run:
1. `tsc --noEmit` — currently 0 Sprint H errors (pre-existing errors in `extraction.service.spec.ts` etc. are not blockers)
2. Add an integration test: `upload → 4 stages → SSE terminal → doc COMPLETED`
3. Verify cross-tenant test passes (tenant B cannot trigger tenant A's pipeline)

*Fim do REVIEW-FINDINGS. Status: needs fix.*
