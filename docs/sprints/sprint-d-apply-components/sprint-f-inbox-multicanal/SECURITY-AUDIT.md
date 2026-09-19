# SECURITY-AUDIT — Sprint F (Inbox multi-canal)

**Auditor**: SECURITY-AUDITOR (Opus 5 persona)
**Date**: 2026-09-04
**HEAD**: 82f6ca9
**Scope**: Sprint F — email-inbound (Gmail + Outlook OAuth + polling) + scanner (chokidar file watcher)
**Mode**: READ-ONLY

---

## TL;DR

- **BLOCKER**: 1 — CSRF state is NOT single-use and NOT expiry-checked in the OAuth callbacks. The existing `OAuthStateStore.consume()` (which deletes the row + validates `expiresAt`) is never called by `OAuthController.googleCallback/microsoftCallback`. Instead both callbacks bypass it with a direct `prisma.integration.findFirst()` lookup. The whole sentinel-key+TTL machinery is dead code on this path.
- **HIGH**: 3 — fileKey without `_inbox/` prefix in inbound pipeline (regression of Sprint E bug); missing MIME signature check on scanner/gmail/outlook path; disconnect + status endpoints have no RBAC and no audit log.
- **MEDIUM**: 4 — no rate-limit / 429 backoff in Gmail/Outlook polling; no MAX_FILE_SIZE / DoS guard on scanner drop; poller `this.running` flag is process-local (broken under cluster); cross-tenant OAuth state row has un-checked tenantId equality.
- **LOW**: 4 — scanner `watchPath` returned by API (no auth); refresh-token theft risk for long-lived tokens; 2 attachments in same email processed via `Promise.all` race; migration `ALTER TYPE ADD VALUE IF NOT EXISTS` on rolling deploy.

---

## Findings

### BLOCKER

#### B-01 — CSRF state is not single-use and not expiry-checked on the callback path
**Files**: `apps/api/src/modules/email-inbound/oauth.controller.ts:60-88` and `:103-136`
**Linked store**: `apps/api/src/modules/integrations/core/oauth-state.store.ts:89-134`

The `OAuthStateStore.put()` is called when state is generated (`gmail.service.ts:77`, `outlook.service.ts:73`), but the **callback path bypasses `consume()` entirely**:

```ts
// oauth.controller.ts:66-72 (Gmail) — same shape for Outlook at :114-120
const session = await this.prisma.integration.findFirst({
  where: {
    tenantId: '__oauth_states__',
    provider: `__state__:gmail:${state}`,
  },
  select: { credentials: true },
});
```

What is missing vs. the contract advertised by `OAuthStateStore`:
1. `consume()` performs `findUnique` + JSON parse + `expiresAt < now()` check + `delete` (atomic). The controller never calls it; the row never gets deleted on a successful callback.
2. The controller never reads or compares `expiresAt` from the persisted payload.
3. Concurrency: `consume()` is documented as "the store's consume() returns the row if-and-only-if it was present" (line 21-22) — meaning a race between two callbacks with the same state is atomic. The controller's `findFirst` + downstream `handleCallback` has no such atomic gate.

Consequences:
- **Replay**: a captured `?code=…&state=…` URL can be redeemed repeatedly. The Google/Outlook token-exchange will reject the second use of `code` (they are one-shot), so the direct impact is limited — but the **CSRF defence in depth is gone**: any code that already has a valid OAuth callback shape (e.g. an internal test stub or a future change to `handleCallback`) is now replayable across the 10-minute TTL window.
- **Tenancy drift**: nothing in the controller path verifies that `payload.tenantId` matches the JWT identity — there is no JWT in the callback (it is `@Public()`), but the lookup keys on the synthetic tenantId + sentinel provider. A state minted under tenant A and replayed by an attacker hitting the callback while tenant A is the *intended* target succeeds — which is the design — but if a future maintainer accidentally ties `payload.tenantId` to a session, there is no defense left in the controller.
- The expiry check (`expiresAt < now()`) is enforced only when `consume()` is called. Bypassing it removes the 10-minute ceiling.

**Fix sketch**: call `this.oauthStates.consume(provider, state)` instead of the inline `findFirst`; let the store return `{ tenantId, redirectUri }`; feed `tenantId` into `handleCallback` as today; on miss / expiry throw `UnauthorizedException('Invalid OAuth state')`.

Severity rationale: BLOCKER because the OAuth-CSRF defence is the *primary* security guarantee of this whole feature surface and the bypass is structural (a missing call to `consume()`), not a config gap.

---

### HIGH

#### H-01 — Inbound pipeline writes `fileKey` without `_inbox/` prefix (regression of Sprint E bug)
**File**: `apps/api/src/modules/inbound/inbound.service.ts:64`

```ts
const fileKey = `inbound/${input.tenantId}/${fileHash}-${safeName}`;
```

`relocateAfterApprove()` keys off `isInboxKey(fileKey)` (`documents.service.ts:1553`) which only matches `_inbox/<tenant>/...` or `<tenant>/_inbox/...`. The inbound path emits `inbound/<tenant>/...` — which matches **neither** — so `relocateAfterApprove` short-circuits at the guard and the file is never routed to fornecedores/clientes/estrangeiras. Sprint E was fixed by d261947 (buildStorageKey got the `_inbox/` prefix). Sprint F now adds a parallel ingest path that misses the same fix.

Affected sources:
- Scanner (`scanner.service.ts:159` → `inbound.ingestFiles`)
- Gmail poller (`gmail.service.ts:227`)
- Outlook poller (`outlook.service.ts:209`)
- IMAP cron (pre-existing path)
- SendGrid/Mailgun webhooks (pre-existing path)

**Fix**: change `fileKey` in `PrismaInboundDocumentsAdapter.createFromInbound` to `buildStorageKey(tenantId, originalname, now)` so all inbound paths emit the same shape that `isInboxKey` accepts. (Or relax `isInboxKey` to accept `inbound/` too, but the canonical Sprint E key shape is `_inbox/`.)

#### H-02 — MIME signature check bypassed for scanner / gmail / outlook paths
**Files**: `apps/api/src/modules/inbound/inbound.service.ts:50-82`, contrasted with `apps/api/src/modules/documents/documents.service.ts:131-141`

The upload path (`DocumentsService.upload`) calls `assertMimeMatchesSignature(buffer, mimetype)` before persisting (defense-in-depth against MIME confusion / polyglot HTML-as-PDF attacks — explicitly cited at `documents.service.ts:124-141`).

The inbound path (`PrismaInboundDocumentsAdapter.createFromInbound`) does NOT call it. The `validateFile` filter in `inbound.service.ts:517-523` only checks `extension`, `size`, and `mime` string — it never reads the bytes. Result: scanner/gmail/outlook ingestion can persist an HTML file declared as `application/pdf` and it will go straight into `documents` (and through to AI extraction / preview rendering).

This is the exact regression that audit-and-ui-overhaul/AUDIT-REPORT.md §4.8 called out for the upload path; Sprint F reopens it for every other ingest channel.

**Fix**: in `PrismaInboundDocumentsAdapter.createFromInbound`, call `assertMimeMatchesSignature(input.file.buffer, input.file.mimetype)` before `storage.put`.

#### H-03 — OAuth disconnect + status endpoints have no RBAC and write no audit log
**File**: `apps/api/src/modules/email-inbound/oauth.controller.ts:140-198`

- `disconnect()` (line 140) has only `@ApiBearerAuth()` + `@CurrentTenant()`. No `@Roles()` guard. An `OPERADOR` user can disconnect the tenant's Gmail/Outlook integration. The summary at line 143 says "keeps audit trail" but the body never calls `this.audit.log(...)`.
- `status()` (line 158) likewise has no role guard — any tenant user can enumerate which providers are connected and read the **bound email address** of the Gmail/Outlook mailbox (line 184 decrypts `credentials` to surface `email`). For Outlook that is the `mail` / `userPrincipalName` of the connected user — an information-disclosure issue if OPERADOR should not see admin-level config.

**Fix**:
- `disconnect`: `@Roles(Role.ADMIN)` and call `this.audit.log({ action: AuditAction.DELETE, entityType: 'integration', entityId: integrationId, metadata: { provider } })`.
- `status`: keep `@ApiBearerAuth()` but consider restricting to ADMIN OR mask the `email` field for non-ADMIN users (current shape leaks the inbox owner's identity to anyone in the tenant).

---

### MEDIUM

#### M-01 — No 429 / exponential backoff in Gmail and Outlook polling
**Files**: `gmail.service.ts:184-199` (Gmail list), `:303-321` (Gmail attachment), `:194-226` (Outlook)

Every `fetch()` raises on `!res.ok` and immediately continues to the next message. Google and Microsoft both throttle with 429 + `Retry-After`. Without backoff:
- A single busy tenant can push the cron to 100% error rate for everyone else.
- A 429 returned mid-message-loop aborts the whole `pollTenant()` (only the first error is captured into `errors[]`); the rest of the unread attachments for the cycle are skipped until the next 5-minute tick.

**Fix**: a small helper that reads `Retry-After`, sleeps, and retries up to 3×; back off the cron on persistent 429.

#### M-02 — Scanner accepts arbitrarily large files (no DoS guard)
**File**: `apps/api/src/modules/scanner/scanner.service.ts:127-173`

`handleAdd()` reads the entire file into a buffer via `fs.readFile(filePath)` with no size pre-check. Gmail/Outlook apply a 10MB cap (`MAX_FILE_SIZE` at `gmail.service.ts:46`). The scanner does not — a 100GB drop on the watch path causes `fs.readFile` to allocate 100GB of RSS and likely OOM-kills the API.

`awaitWriteFinish.stabilityThreshold: 2000` doesn't bound size.

**Fix**: `await fs.stat(filePath)` first; refuse `> 50MB` (or whatever aligns with the storage backend's limit) before `readFile`.

#### M-03 — Poller `this.running` flag is process-local — breaks under cluster mode
**File**: `apps/api/src/modules/email-inbound/poller.service.ts:19, 28-58`

`private running = false` is an instance variable. If two Node processes run the same API (cluster / PM2 / multi-replica), BOTH run the cron every 5 minutes, both call Gmail/Outlook polling for the same `(tenantId, provider)` row, and both ingest the same unread message → two `Document` rows with the same `fileHash`.

The schema has `@@unique([tenantId, fileHash])` so the second insert throws P2002. But the catch in `prisma.document.create` (`documents.service.ts:239-256`) only catches the violation, not the upstream duplicate ingestion cost (API quota spend).

**Fix**: rely on Prisma's P2002 dedup (already in place) AND consider an advisory lock — `SELECT pg_advisory_xact_lock(?)` keyed by `provider || tenantId` at the top of `pollTenant()` to serialize across replicas.

#### M-04 — Cross-tenant OAuth state row never compared against an authenticated identity
**File**: `apps/api/src/modules/email-inbound/oauth.controller.ts:66-87`

The callback is `@Public()` (correct — Google/MS redirect without a JWT). The state row stores `payload.tenantId` minted by `generateAuthUrl()`. Nothing in the callback compares `payload.tenantId` to anything else — there is no JWT, so nothing to compare to. This is fine for the OAuth CSRF threat model in isolation (the state itself is the auth), but combined with **B-01** (state is not single-use), an attacker who can phish a callback URL into the wrong tenant context can re-bind that tenant's Gmail/Outlook row. Fixing B-01 closes the door.

---

### LOW

#### L-01 — `GET /scanner/status` is not RBAC-protected and returns the watch path
**File**: `apps/api/src/modules/scanner/scanner.controller.ts:37-41`

Only `@ApiBearerAuth()`, no `@Roles()`. Any authenticated tenant user can read the absolute filesystem path the operator chose (`scanner.service.ts:48-50`). Not exploitable on its own (the path is server-side), but:
- Information disclosure (path layout, deployment conventions).
- The React UI renders `{watchPath}` directly into text (`scanner-config.tsx:86`) — React auto-escapes so no XSS, but still reveals the layout.

**Fix**: `@Roles(Role.ADMIN, Role.GESTOR_RH)` for symmetry with `start`/`stop`.

#### L-02 — Refresh tokens stored encrypted at rest; theft window is long-lived
**Files**: `gmail.service.ts:154-167`, `outlook.service.ts:138-152`, `oauth-crypto.ts:18-37`

The envelope is AES-256-GCM with `INTEGRATION_ENC_KEY` (good — same envelope as IMAP and the rest of the integration surface). Gmail refresh tokens are effectively permanent until the user revokes (Sprint F forces `prompt=consent` at `gmail.service.ts:88` which is the correct Google-side defence). Outlook refresh tokens roll forward on each refresh and last up to 90 days of inactivity (`outlook.service.ts:272` correctly persists `body.refresh_token ?? tokens.refreshToken`).

Threat: if `INTEGRATION_ENC_KEY` leaks, every tenant's mailbox is readable. Mitigation exists in `oauth-crypto.ts:19-23` (env-var-required) but no key-rotation path is in place.

**Fix**: document the rotation procedure (decrypt-all with old key + re-encrypt with new in a maintenance window); consider a per-tenant key envelope (KMS-wrapped DEK).

#### L-03 — Two attachments from same email processed in parallel may race `createFromInbound`
**Files**: `gmail.service.ts:210-224`, `outlook.service.ts:193-208`

Both polls fetch attachments via `Promise.all` and pass them to `InboundService.ingestFiles` (which itself `Promise.all`s into `createFromInbound`). The schema's `@@unique([tenantId, fileHash])` is the only gate; the catch in `documents.service.ts:239-256` converts P2002 into a 409. Today the API returns `created` only on success, so the failing ingest silently drops one of the duplicates (no audit row, no operator-visible log beyond the warn at line 192). For an email with two attachments that hash-equal (rare, but identical PDFs are common in invoice batches), only one survives.

**Fix**: dedup inside `pollTenant()` before invoking `ingestFiles` — `Array.from(new Set(accept.map(a => a.size + ':' + a.filename)))` or compute SHA-256 on the bytes first.

#### L-04 — Migration uses `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
**File**: `apps/api/prisma/migrations/20260904000002_add_origin_gmail_outlook_inbound_webhook/migration.sql`

Postgres ≤11 cannot run `ALTER TYPE ADD VALUE` inside a transaction block. PG 12+ (project's PG15+ per the comment) is fine, so no deploy lock under the standard `prisma migrate deploy`. The `IF NOT EXISTS` makes the migration idempotent, which is the correct hedge for rolling multi-replica deploys where one replica applies the migration and another is mid-poll.

Threat: very low. If a poll reads the `DocumentOrigin` enum column with an old `pg_enum` cache and a new value is committed mid-poll, Postgres returns the cached OID and the new value writes as `NULL` (column type mismatch). Worth a follow-up but not blocking.

---

## What is OK

- **AES-256-GCM envelope** with 96-bit IV + auth tag (`oauth-crypto.ts:18-37`). Same envelope as `IntegrationsService` — consistent.
- **Scopes are read-only**: `gmail.readonly` + `userinfo.email` (`gmail.service.ts:12-15`), `Mail.Read` + `User.Read` + `offline_access` (`outlook.service.ts:12`).
- **State is 32-byte random** (`gmail.service.ts:76`, `outlook.service.ts:72`).
- **Refresh skew 60s before expiry** (`gmail.service.ts:261`, `outlook.service.ts:242`) — correct.
- **Cross-tenant CSRF prevention via OAuthStateStore** — *designed correctly*; the controller simply doesn't use it (B-01).
- **Tenant scoping in `pollTenant`** — every Prisma read keys on `tenantId_provider` (`gmail.service.ts:155, 175, 248, 289`; `outlook.service.ts:139, 158, 229, 277`). No leakage.
- **Poller iterates only active rows** (`poller.service.ts:35-41`).
- **`awaitWriteFinish: 2000`** — fits Sprint F SCOUT recommendation.
- **`ignored: /(^|[/\\])\../`** — dotfiles blocked.
- **MIME type allowlist + size filter in `validateFile`** (`inbound.service.ts:517-523`) — first-line defence (signature check missing — H-02).
- **No refresh-token, access-token, or code leaks in logs** — no `console.log(tokens)` style calls; only `logger.warn` on userinfo failures (no token content).
- **`@Public()` only on the two callback GETs** (`oauth.controller.ts:55, 103`) — required for provider redirects. Everything else is `@ApiBearerAuth()`.
- **scanner RBAC on `start`/`stop`** (`scanner.controller.ts:22, 30`) — ADMIN/GESTOR_RH only. Status missing (L-01).
- **React auto-escapes `watchPath`** in the scanner UI — no XSS.

---

## Recommendation

**Status**: BLOCKED.

Fix B-01 (route the callback through `OAuthStateStore.consume()`) and H-01 (fileKey `_inbox/` prefix) before merging. H-02 (MIME signature in inbound path) and H-03 (RBAC + audit on disconnect/status) are the next priority — these are easy follow-up PRs but should not slip into a release with the BLOCKER.

Once B-01 + H-01 land and a regression test pins both fixes (CSRF replay + folder-routing on a scanner-ingested file), re-run this audit.

---

## TypeScript

`npx tsc --noEmit` — no errors in `email-inbound/` or `scanner/`. Pre-existing test-only typecheck noise in `documents.service.spec.ts`, `extraction.service.spec.ts`, `integrations.e2e.spec.ts`, `payments.service.spec.ts` is unchanged by Sprint F.

---

## Evidence

| Check | Where | Result |
|---|---|---|
| OAuthStateStore.consume() called from controller? | grep `consume\|oauthStates` across `email-inbound/` | NO — only `put()` is called |
| fileKey prefix from inbound path | `inbound.service.ts:64` | `inbound/<tenant>/<hash>-<name>` — fails `isInboxKey` |
| assertMimeMatchesSignature from inbound path | `inbound.service.ts:50-82` | NOT called |
| RBAC on disconnect | `oauth.controller.ts:140-156` | absent |
| RBAC on status | `oauth.controller.ts:158-198` | absent |
| 429 / backoff in poller | grep `429\|backoff\|retry` in `email-inbound/` | absent |
| Scanner size cap | grep `MAX_FILE\|statsync\|fileSize` in `scanner/` | absent |
| Refresh token leak in logs | grep `tokens\|accessToken\|refreshToken` in log calls | none |
