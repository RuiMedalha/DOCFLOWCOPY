# Sprint F (Inbox multi-canal) — Code Review

> Working dir: `C:\Projetos\docflow-mvp`
> Branch / HEAD: `main` @ `82f6ca9`
> Reviewer: Opus 5 (code-reviewer)
> Date: 2026-09-04
> Scope: backend (scanner + email-inbound OAuth + DTO/service filter + migration) and frontend (page.tsx + 3 new components)
> Tests: **5 suites / 22 tests, all green** (`pnpm jest --testPathPatterns="(scanner|email-inbound|documents-origin)"`)
> TypeScript: clean for Sprint F files (pre-existing errors in unrelated test files ignored)

---

## Verdict: `{status:"blocked"}`

**One BLOCKER found** that must be fixed before this ships. Two HIGH concerns that should be fixed in the same change set. Two MEDIUM / LOW improvements worth noting.

---

## Findings

### 🔴 BLOCKER — `oauth.controller.ts:65-87` and `:112-136` — OAuth state is NOT single-use

**Severity:** BLOCKER
**File:** `apps/api/src/modules/email-inbound/oauth.controller.ts:65-87, 112-136`
**Category:** correctness + security

**Description.**
The OAuth callback reads the state row via `prisma.integration.findFirst(...)` (lines 66-72 and 114-120) and then calls `gmail.handleCallback` / `outlook.handleCallback`. **It never calls `oauthStates.consume(...)` and never deletes the state row.** The state row stays alive in the `Integration` table until `expiresAt` (10 min default in `OAuthStateStore.put`).

A second callback (or an attacker who captures the `state` value, e.g. via a malicious redirect from a browser) for the same `state` within the 10-minute window will:
1. Find the same row in `findFirst` (it still exists).
2. Look up the `tenantId` from the stored credentials.
3. Call `handleCallback` again with the captured `code` (or a different `code`).
4. If the second `code` is valid Google/Microsoft code, the Integration row is overwritten with the attacker's tokens — including the attacker's `refreshToken`.

This is exactly the threat model `OAuthStateStore` was built to defend against (its `consume()` deletes the row to make state single-use). The store has the right primitive; the controller just doesn't call it.

**Failure scenario.**
1. Tenant-A clicks "Connect Gmail" → server writes state `S` for tenant-A.
2. Tenant-A's user clicks "Connect Gmail" again before completing → server writes a *new* state `S'`. State `S` is still in the DB.
3. Attacker (e.g. via a malicious link delivered to the user, or replaying a leaked state) hits `/oauth/google/callback?code=<valid>&state=S` and successfully attaches *their* Google account as tenant-A's Gmail integration. From that moment on, every email the attacker sends from that Gmail is ingested into tenant-A's inbox.

**Fix.**
Inject `OAuthStateStore` into `OAuthController` and replace the `findFirst` lookup with `consume`:

```ts
const session = await this.oauthStates.consume('gmail', state);
if (!session) throw new UnauthorizedException('Invalid or expired OAuth state');
await this.gmail.handleCallback(code, state, session.tenantId, 'system');
```

`consume()` does the `findUnique` + `expiresAt` check + `delete` atomically (per `oauth-state.store.ts:108-133`), giving both single-use and TTL in one call. Remove the ad-hoc `findFirst` + `JSON.parse(String(session.credentials))` block (lines 66-77 and 114-124) and let `consume` handle payload parsing.

The replay test in `oauth-csrf.spec.ts:96-121` simulates this with a Prisma mock, but the test itself is misleading — it works only because the mock makes `findFirst` return null on the second call. In production, the controller never deletes the row, so the second real callback *would* find it. **The test passes against fake Prisma, not against the real wire.** Update the test to assert that `consume` is called (or use a real `OAuthStateStore` in the test) so the assertion matches production behavior.

---

### 🟠 HIGH — `oauth.controller.ts:75, 123` — Misleading comment claims encrypted envelope

**Severity:** HIGH (correctness / maintenance hazard)
**File:** `apps/api/src/modules/email-inbound/oauth.controller.ts:75, 123`

**Description.**
The comment and code claim the state row's `credentials` is an "encrypted envelope", but in production the state row is written by `OAuthStateStore.put` (`oauth-state.store.ts:65-70`) with `credentials: JSON.stringify(...)` — plain JSON, no encryption. The `encryptJson` / `decryptJson` envelope is only used for the *real* `Integration(provider='gmail'|'outlook')` rows, not for the state rows.

The test (`oauth-csrf.spec.ts:25`) round-trips through `encryptJson`, which masks the production mismatch. Two developers reading the comment will assume `__oauth_states__` rows are encrypted at rest, which is fine (the state token itself is the secret, not the row content), but the divergence from `OAuthStateStore.put` is a real footgun.

**Fix.** Once the BLOCKER is fixed and the controller delegates to `oauthStates.consume`, the misleading lines go away naturally. If for any reason the controller still needs to read the state payload directly, drop the "encrypted envelope" claim and document that state rows are plain JSON with the random state token acting as the access secret.

---

### 🟠 HIGH — `poller.service.ts:27-57` — Gmail blocking loop can starve Outlook tenants (and vice-versa)

**Severity:** HIGH
**File:** `apps/api/src/modules/email-inbound/poller.service.ts:27-57`

**Description.**
The `@Cron(EVERY_5_MINUTES)` iterates all active `Integration(provider IN ['gmail', 'outlook'])` rows **sequentially** in a single `for` loop. There is one `this.running` mutex, so if Gmail tenant-A has 200 messages to fetch (each with 3+ attachments and a slow `fetchMessage` call), the next Gmail tenant-B AND every Outlook tenant in the system wait until the entire Gmail set drains. If Gmail tenant-A's `pollTenant` throws unexpectedly or hangs on a transient Google API 5xx, the `try/catch` inside the loop only logs — the next iteration runs — but if the upstream hangs (no timeout on `fetch`), the whole poller stalls. Outlook polling never gets a tick.

Additionally:
- `gmail.pollTenant` calls `fetch(...)` with no `AbortSignal` / timeout (`gmail.service.ts:191-194`, `:305-308`, `:314-317`) — a hung Google request blocks the loop indefinitely.
- `outlook.pollTenant` has the same gap (`outlook.service.ts:170-172`, `:181-184`, `:195-199`).

**Failure scenario.**
At 5-minute mark, Gmail tenant-A has a 200-message backlog. The loop starts at tenant-A's Gmail row. Each message triggers 3 fetch round-trips (list + message + each attachment). Total ~600 fetch calls. With 50ms RTT to Google this is ~30s of synchronous wait before Outlook tenants get a turn. If Google returns 503 (no timeout), the loop hangs forever — Outlook polling dies.

**Fix.**
Two complementary changes (pick at least one):

1. **Per-provider parallelism**: split the loop into two — one per provider, run via `Promise.all([gmailLoop(), outlookLoop()])`. Each provider's `running` flag becomes per-provider, so a stuck Gmail doesn't block Outlook.

2. **Fetch timeout**: wrap every `fetch(url, ...)` call in `AbortSignal.timeout(15_000)` (or `AbortController` + `setTimeout`). A hung provider request aborts cleanly, the `try/catch` logs the timeout, and the loop moves on.

3. (Bonus) **Per-tenant `Promise.allSettled` inside `pollAll`**: keep the `for` loop but parallelize across tenants within a provider. Lowest-risk improvement.

Whichever you pick, make sure the `this.running` mutex isn't so coarse that one slow provider starves the other.

---

### 🟡 MEDIUM — `gmail.service.ts:225` — Double extension check with bug-prone partial-match logic

**Severity:** MEDIUM
**File:** `apps/api/src/modules/email-inbound/gmail.service.ts:225`

**Description.**
```ts
const valid = inboundFiles.filter((f) => ACCEPTED_EXTS.has(f.originalname.split('.').pop()?.toLowerCase() ?? ''));
```
This is fine for `.pdf`, `.png`, `.jpg`, `.jpeg`, `.docx`, but it silently accepts filenames with NO extension at all (the optional chain returns `undefined`, `?? ''` gives empty string, `ACCEPTED_EXTS.has('')` is `false`, so it's actually correctly rejected). The `acceptByExt` helper at `:344-348` runs the same check earlier. So this is a *redundant* check that performs the validation twice (with two slightly different implementations — `acceptByExt` returns `false` for missing filenames, this one returns `false` too via `?? ''`, but the helper handles `undefined` explicitly).

Real bug, though, is upstream: `acceptByExt` returns `false` for files with no extension, but Gmail message parts where `payload.filename` is set but the file ends up being something weird (e.g. `.tar.gz`) — `split('.').pop()` returns `'gz'` which is NOT in `ACCEPTED_EXTS`, so it's correctly rejected. OK.

**Practical impact.** Low — the duplicate check is harmless. But the `acceptByExt` filter runs *before* this one and gates `inboundFiles`, so this second filter is dead code on the happy path and a maintenance hazard (someone changing `ACCEPTED_EXTS` here might miss the helper, or vice versa).

**Fix.** Drop the inline filter at `:225`; the `acceptByExt` filter at `:207-208` already gates the set. Single source of truth for the extension allowlist. Same applies to `outlook.service.ts:186-191` (single filter, no duplication — that one is actually fine).

---

### 🟡 MEDIUM — `scanner.service.ts:149-171` — No cleanup of processed file (re-ingestion on every restart)

**Severity:** MEDIUM (correctness / operational)
**File:** `apps/api/src/modules/scanner/scanner.service.ts:149-171`

**Description.**
After a file is ingested, the chokidar watcher doesn't move it to a `.processed/` subdir or delete it. With `ignoreInitial: true` and `awaitWriteFinish: { stabilityThreshold: 2000 }`, the *first* scan after `start()` ignores pre-existing files, so a single boot is safe. **But every subsequent restart of the API process leaves the previously-ingested file in place** — meaning a long-lived deployment accumulates a directory full of files that, if the watcher is ever re-enabled and `ignoreInitial` is flipped (or the file is touched/replaced), get re-ingested.

The SCOUT explicitly raised this risk in §5.2 ("Optionally move file to `.processed/` subdir"). The implementation skipped it.

**Failure scenario.**
1. Day 1: operator starts scanner; tenant-A drops 10 PDFs; all 10 ingested with origin SCANNER.
2. Day 30: API restarts; scanner restarts; the 10 PDFs are still in the folder but `ignoreInitial: true` means they are not re-ingested (good).
3. Day 31: an admin touches one of the files (or `chokidar` re-fires `add` due to an inode change); the same PDF gets ingested a second time, producing a duplicate document row. The downstream `createFromInbound` will catch this via the `fileHash` de-duplication path (per Sprint F discussion), so the *user-visible* impact is "no second document", but the operator sees `lastSyncStatus: partial` and the warning log "scanner ingested X" twice, masking real failures.

**Fix.** After successful ingest, `await fs.rename(filePath, path.join(path.dirname(filePath), '.processed', fileName))`. Create `.processed/` at `start()`. This also matches the SCOUT's recommendation in §5.2.

---

### 🟢 LOW — `gmail.service.ts:181` and `outlook.service.ts:163` — No defense-in-depth for missing `integration.credentials` envelope

**Severity:** LOW (only exploitable via DB tampering)
**File:** `apps/api/src/modules/email-inbound/gmail.service.ts:181`, `outlook.service.ts:163`

**Description.**
```ts
const tokens = decryptJson<GmailTokens>(String(integration.credentials));
```
If `integration.credentials` is corrupted or was tampered with to a non-envelope shape (e.g. an attacker who already has DB write access replaces the envelope with raw text), `decryptJson` throws — but `pollTenant` doesn't catch that exception locally; it propagates up to `PollerService.pollAll`, where the `try/catch` logs it and moves on. **Good** — no leak.

However, the `outlook.refreshAccessTokenIfNeeded` (line 281) uses the same `tokens.refreshToken` from the envelope, and if the envelope is corrupted but happens to be a valid JWT, the refresh request goes out with whatever value is there. This is purely a "DB compromise" threat model — `INTEGRATION_ENC_KEY` is in env, not DB, so a DB-only attacker can't forge valid envelopes.

**Verdict.** No fix needed. The encryption-at-rest pattern is correct. Note this in the threat model as already-handled.

---

### 🟢 LOW — `scanner.service.ts:73` — Dotfile ignore pattern allows `.processed/` re-ingestion

**Severity:** LOW
**File:** `apps/api/src/modules/scanner/scanner.service.ts:73`

**Description.**
```ts
ignored: /(^|[/\\])\../, // dotfiles
```
This excludes any path segment starting with `.`. If we adopt the MEDIUM fix above and move processed files to `.processed/`, chokidar correctly ignores them. **But** the `watcher.on('add', ...)` handler also re-checks `mimeForExt` and tenant prefix, so even without the dotfile filter, junk files are skipped. The dotfile filter is fine — flagging it because once the rename-to-`.processed/` fix lands, double-checking the filter is important.

---

### ✅ Items checked and clean

- **chokidar race condition** (`scanner.service.ts:69-72`): `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }` is correctly configured. 2s stability threshold handles PDF-from-network-scanner copies and large image scans. The handler then does `fs.readFile` *after* the `add` event fires (which is gated by the awaitWriteFinish), so no partial-read race.
- **MIME validation**: `scanner.service.ts:175-184` maps extensions to MIME, then `InboundService.ingestFiles` (via `validateFile`) re-validates against the `ACCEPTED_MIME_TYPES` allowlist (per SCOUT §5.2). No duplicated allowlist, no duplicated MIME trust.
- **Refresh token expiry** (`gmail.service.ts:257-292`, `outlook.service.ts:238-281`): `REFRESH_SKEW_MS = 60_000` proactively refreshes 60s before `expiresAt`. `outlook.refreshAccessTokenIfNeeded` correctly preserves `tokens.refreshToken` when the refresh response doesn't include one (Microsoft rotates refresh tokens inconsistently; Outlook-only).
- **Crypto** (`oauth-crypto.ts:18-56`): AES-256-GCM with 12-byte random IV per encryption, 32-byte key derived from `INTEGRATION_ENC_KEY` via SHA-256. Same shape as the existing IMAP envelope. No plain-text refresh tokens anywhere in the codebase — verified by grepping for `JSON.stringify` near credentials.
- **Tenant isolation in `gmail.pollTenant` / `outlook.pollTenant`**: every query is keyed on the `tenantId` passed by `PollerService.pollAll`, which itself sources `tenantId` from `integration.tenantId`. No cross-tenant read paths.
- **Tab rendering** (`page.tsx`, `inbox-tabs.tsx`, `scanner-config.tsx`, `email-config.tsx`): 3 tabs swap correctly via `useState<InboxTabKey>`. `TAB_ORIGINS` correctly maps `email` → `['EMAIL', 'GMAIL', 'OUTLOOK', 'INBOUND_WEBHOOK']` and `scanner` → `['SCANNER']`. `pdf` sends `undefined` so all origins pass.
- **BuildWhere filter** (`documents.service.ts:1281-1283`): `if (query.origin && query.origin.length > 0) where.origin = { in: query.origin }` — correctly short-circuits to `undefined` when no filter.
- **Migration** (`20260904000002_add_origin_gmail_outlook_inbound_webhook/migration.sql`): `ALTER TYPE ... ADD VALUE IF NOT EXISTS` x3. Idempotent and safe for PG15+. Matches §3 row 2 of the SCOUT report.
- **Tests**: 22/22 pass. Origin DTO transform matrix covers single/CSV/array/unknown-value/empty/whitelist combination.

---

## Summary

| Severity | Count |
|----------|-------|
| BLOCKER | 1 |
| HIGH    | 2 |
| MEDIUM  | 2 |
| LOW     | 2 |

**Recommendation:** Block Sprint F merge until the BLOCKER (OAuth state single-use via `consume()`) is fixed. Both HIGHs are also blocking-grade — the misleading-comment one disappears with the BLOCKER fix, and the poller serialization / fetch timeout should land in the same commit. MEDIUMs can ship as follow-ups if scope is tight.

---

*End of REVIEW.*
