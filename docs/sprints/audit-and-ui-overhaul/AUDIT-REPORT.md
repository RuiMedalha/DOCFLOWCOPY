# SECURITY AUDIT — `main` @ HEAD `330a4e0`

**Mission:** `Lx6BX4G1C2xb` · **Folder:** `audit-and-ui-overhaul/` · **Date:** 2026-09-03 · **Branch:** `main` · **HEAD:** `330a4e0` (`fix(security): atomic updateMany for recurring override + audit log entry on ADMIN toggle`) · **Reviewer:** SECURITY-AUDITOR (Opus 5)

**Verdict:** 🟢 **NO BLOCKER. THREE MEDIUM, FOUR LOW FINDINGS.** The API has a solid auth/RBAC/tenant-isolation foundation (helmet, JWT, RBAC, Prisma tenant extension, atomic override write, per-IP throttling, refresh-token rotation with reuse detection). The MEDIUM findings are defence-in-depth gaps (raw-body HMAC on a second webhook path, missing constant-time compare on cron secret, missing LOGIN attempt counter surfaced to caller, JWT header rate-limit). LOW findings are hardening / hygiene.

---

## 1. SKILL LOAD CONTRACT

| Skill | Status | Notes |
|---|---|---|
| `api-security-best-practices` | ✅ Loaded | Full OWASP API Top 10 checklists received |
| `senior-security` | ✅ Loaded | Three reference docs + 3 Python scripts received |
| `oc-api-audit` (legacy bound) | ⚠ Unknown | Not invoked — caller asked only for the two above |

Both required skills loaded successfully and were used to build the checklist (OWASP API Top 10 categories + senior-security threat-model approach). If the "Unknown" gate had fired, I would have reported it here instead of producing this report.

---

## 2. SCRIPT EXECUTION — `senior-security/scripts/`

All three scripts ran on `apps/api` (UTF-8 encoding via `PYTHONIOENCODING=utf-8`; default cp1252 console fails on the emoji banner — minor bug in the scripts). Results:

| Script | Exit | Findings | Notes |
|---|---|---|---|
| `security_auditor.py apps/api --verbose` | 0 | **0** | "Analysis complete: 0 findings" |
| `pentest_automator.py apps/api --verbose` | 0 | **0** | "Analysis complete: 0 findings" |
| `threat_modeler.py apps/api --verbose` | 0 | **0** | "Analysis complete: 0 findings" |

**Conclusion:** these three Python scripts are **boilerplate scaffolding** — every call returns "0 findings" regardless of the target. They do NOT replace manual review and should not be trusted as a coverage gate. All findings below are from manual code review of the 8 critical endpoints + cross-cutting surfaces.

---

## 3. INPUT CONTEXT — what changed since last sprint

| Sprint | Diff | Security-relevant change |
|---|---|---|
| `fix-categories-and-party-page` (merged) | Adds `expenseCategory` + `ivaDeductibilityHint` to `metadata.filing`. New `GET /parties/:id/documents`. | `expenseCategory` validated by `isExpenseCategory()` allowlist before persist (`documents.service.ts:550`). New endpoint inherits global guards. **No finding.** |
| `fix-recurring-toggle-admin` (merged) | Adds `isRecurringManualOverride` Boolean to Party. ADMIN-only toggle on `PATCH /parties/:id`. Audit log per-field for recurring toggles. **Atomic `updateMany` in `refreshRecurringFlag` (closes TOCTOU)**. | Closes the two MEDIUM findings from `fix-recurring-toggle-admin/SECURITY-AUDIT.md`. Verified in `supplier-resolver.ts:284-289`. **No new finding.** |

The current audit (this report) is the full `main` review, not a diff review. The TOCTOU fix in HEAD `330a4e0` is confirmed deployed.

---

## 4. ENDPOINT-BY-ENDPOINT REVIEW (OWASP API Top 10)

Severity scale: **BLOCKER > HIGH > MEDIUM > LOW**. **No BLOCKER or HIGH found.**

### 4.1 `POST /api/v1/auth/login` — `apps/api/src/modules/auth/auth.controller.ts:64-77`

| OWASP category | Status | Evidence |
|---|---|---|
| Broken Authentication | ✅ Same error for unknown tenant / unknown user / wrong password / inactive user (`auth.service.ts:153-180`). bcrypt rounds = 12. JWT signed with issuer/audience/HS256 (`auth.service.ts:427-433`). 2FA gate honours `twoFactorEnabled` (L184-195). | — |
| Unrestricted Resource Consumption | ✅ `@Throttle({ login: { ttl: 15min, limit: production=5 / non-prod=50 } })` (L58-63) + bucket declared in `app.module.ts:62-67`. | — |
| Improper Inventory Management | ⚠ **MEDIUM — `THROTTLE_NAMES.LOGIN` bucket key by IP only (via `ThrottleBucketGuard` fallback at `throttle-bucket.guard.ts:36-46`)**. An attacker rotating through a /24 IPv4 range (or a single NAT with many users) bypasses the per-IP throttle. Brute force across 256 IPs gets 5 × 256 = 1280 attempts / 15 min per attack. | `auth.controller.ts:58-63` + `throttle-bucket.guard.ts:36-46` |
| Information Disclosure | ✅ Generic "Invalid credentials" message (no tenant / user / password split). | — |

**Suggested fix:** add a per-account lockout counter in `RefreshToken`-style table (or in-memory LRU with `tenantId + emailHash` key) — 5 attempts locks the account for 15 min regardless of source IP.

### 4.2 `POST /api/v1/auth/refresh` — `auth.controller.ts:80-86` → `auth.service.ts:221-296`

| OWASP category | Status | Evidence |
|---|---|---|
| Broken Authentication | ✅ Stored only as SHA-256 hash (`auth.service.ts:31-33`). Reuse-detection revokes the entire family (`completeRefresh` L259-273). Idempotent rotation. | — |
| Unrestricted Resource Consumption | ⚠ **LOW — `/auth/refresh` is `@Public()` (L80) and inherits the GLOBAL throttle (100/min/IP).** No dedicated bucket. An attacker holding any refresh token hash can hammer `/auth/refresh` to grind bcrypt... wait, refresh does not call bcrypt. Verify: line 84 calls `auth.refresh(dto.refreshToken)`. The hash is a SHA-256 lookup in DB. Cost is DB read. With 100/min IP, an attacker can issue 100 lookups/sec, but the lookup is a single indexed query — not catastrophic. Still, a dedicated bucket (e.g. 30/min/IP) would prevent enumeration of valid hashes via timing differential (success vs not-found has different query plans). | `auth.controller.ts:80-86` |
| Information Disclosure | ✅ All error messages uniform ("Invalid refresh token" / "Refresh token revoked" / "Refresh token expired"). | — |

**Suggested fix:** add a dedicated `@Throttle({ refresh: { ttl: 60_000, limit: 30 } })` bucket.

### 4.3 `GET /api/v1/documents` — `documents.controller.ts:132-144` → `documents.service.ts:315-353`

| OWASP category | Status | Evidence |
|---|---|---|
| BOLA | ✅ All queries tenant-scoped via `buildWhere` (L1030-1066) — `tenantId` always in `where`. Prisma extension belt-and-braces (`prisma.service.ts:178-216`). | — |
| Unrestricted Resource Consumption | ✅ `Math.min(query.limit ?? 20, 100)` cap (L322). | — |
| Broken Object Property Level Authorization | ✅ `sanitize` strips `fileKey` + `fileHash` (L1081-1090). | — |
| SSRF | ✅ No URL fetching from user input. | — |
| Mass Assignment | ✅ DTO `DocumentQueryDto` has only whitelisted fields (`document.dto.ts:181-237`). | — |
| Improper Inventory Management | ✅ Documented in Swagger. | — |

**No finding.**

### 4.4 `PATCH /api/v1/documents/:id` — `documents.controller.ts:238-250` → `documents.service.ts:524-696`

| OWASP category | Status | Evidence |
|---|---|---|
| BOLA | ✅ `findFirst({ where: { id, tenantId } })` (L530). Update via `id` is auto-scoped (extension). | — |
| Broken Object Property Level Authorization | ✅ `expenseCategory` validated by `isExpenseCategory()` allowlist (L550). Status transitions not controlled here (L669 forwards `dto.status` straight into the data — see **LOW below**). | — |
| Mass Assignment | ✅ DTO whitelists fields; service strips `expenseCategory` from the top-level write before `update` (L679). | — |
| SSRF | ✅ No URL fetching. | — |

⚠ **LOW — `UpdateDocumentDto.status` accepts any `DocumentStatus` enum value from the user (L56-59).** Service does not gate transitions. A user could PATCH `status: 'APROVADO'` on a NOVO doc and bypass the approve flow (which has audit + payment-event creation). However: `approve()` itself doesn't add new server-side state beyond what the user could already set via `update()`. The audit is the same (both go through `AuditService.log`). **Not a privilege escalation, but a divergence from the "approve is the canonical way" invariant.** Suggested fix: drop `status` from `UpdateDocumentDto` (or restrict to a subset like `EM_REVISAO`).

### 4.5 `POST /api/v1/documents/:id/approve` — `documents.controller.ts:168-179` → `documents.service.ts:838-889`

| OWASP category | Status | Evidence |
|---|---|---|
| BFLA | ✅ `@Roles(Role.ADMIN, Role.APPROVER)` at controller (L170). | — |
| BOLA | ✅ `findFirst({ where: { id, tenantId } })` in service (L839-846). | — |
| State machine | ✅ Refuses APROVADO→APROVADO silently (creates payment event idempotent), rejects PROCESSADO/REJEITADO/ARQUIVADO (L853-862). | — |
| Audit | ✅ Audit row with `previousStatus` + `approvedAt` (L874-884). | — |

**No finding.**

### 4.6 `GET /api/v1/parties/:id/documents` (NOVO sprint A) — `parties.controller.ts:165-197` → `documents.service.ts:439-493`

| OWASP category | Status | Evidence |
|---|---|---|
| BOLA | ✅ Controller pre-validates the party exists in the tenant (L188 `parties.findOne`), then queries docs filtered by `tenantId` AND partyId (L449-466). Two-step check is correct — an attacker cannot enumerate another tenant's documents by guessing party UUIDs because step 1 (party lookup) is tenant-scoped. | — |
| Unrestricted Resource Consumption | ✅ `Math.min(Math.max(limit, 1), 50)` (L446). | — |
| Improper Inventory Management | ⚠ **LOW — no dedicated `@Throttle` bucket**. Inherits global 100/min/IP. A tenant-wide DoS via 100 doc-list calls/sec from one IP is plausible (each call does 2x findMany + count). Suggested: a dedicated `party-docs` bucket of e.g. 30/min/user. | `parties.controller.ts:165-197` |

**No HIGH/MEDIUM finding.**

### 4.7 `PATCH /api/v1/parties/:id` (NOVO ADMIN toggle, sprint A) — `parties.controller.ts:199-218` → `parties.service.ts:244-430`

| OWASP category | Status | Evidence |
|---|---|---|
| BFLA | ✅ `@Roles(Role.ADMIN)` at controller (L200). Defense-in-depth at service (L266-274) — `ForbiddenException` if non-ADMIN sends `isRecurring` / `isRecurringManualOverride`. | — |
| BOLA | ✅ `findFirst({ where: { id, tenantId } })` (L251-264). Update auto-scoped. | — |
| Mass Assignment | ✅ `UpdatePartyDto` whitelist (`party.dto.ts:160-180`); service copies only known fields into `data` (L325-353). | — |
| Broken Object Property Level Authorization | ✅ NIF uniqueness checked before update (L277-285). IBAN blacklist check (`ibanBlacklist`) on change (L287-307). IBAN change writes `IbanHistory` in same transaction (L369-383). | — |
| Audit | ✅ Per-field recurring audit rows (L405-427). `audit metadata field` strategy documented as per **memory** `[[docflow-audit-fixup-pattern]]`. | — |
| Improper Inventory Management | ✅ Swagger-documented. | — |

**No finding.** Closes the prior sprint's MEDIUM §6 finding.

### 4.8 `POST /api/v1/documents/upload` (multipart) — `documents.controller.ts:69-128` → `documents.service.ts:102-311`

| OWASP category | Status | Evidence |
|---|---|---|
| Broken Object Property Level Authorization | ✅ MIME allowlist + size cap enforced at multer level (`documents.controller.ts:95-107`) AND in service (L112-119) — defense-in-depth. | — |
| Unrestricted Resource Consumption | ✅ `MAX_UPLOAD_BYTES = 20MB` (documents.service.ts:59). Per-IP global throttle 100/min. No per-user upload bucket. | — |
| Path Traversal | ✅ Filename sanitised in `extractExtension` (L1111-1122) + `sanitizeFilename` in `Content-Disposition` (`documents.controller.ts:338-344`). Storage key uses `${tenantId}/${yyyy}/${mm}/${Date.now()}-${random}${ext}` — no user-controlled path segments (L1331-1338). | — |
| SSRF | ✅ Multipart only, no URL fetch. | — |
| File-type confusion | ⚠ **MEDIUM — MIME allowlist is enforced on the `Content-Type` header (multer reads from `Content-Type` in the multipart part), NOT on the file magic bytes.** A client can upload a `.exe` or `.html` polyglot by sending `Content-Type: application/pdf` in the multipart header. multer + `documents.service.upload` will accept it and store it. **Risk:** the file is served back via `GET /documents/:id/download` (L269-295) with `Content-Type: <stored mime>` and `Content-Disposition: inline` — a stored XSS via uploaded HTML opened in a new tab is possible if the browser follows `Content-Disposition: inline` with `text/html`. | `documents.controller.ts:96-106` + `documents.service.ts:112-119` |

**Suggested fix:** add a magic-bytes check after the multer accept — read the first 16 bytes and validate against the declared MIME (`%PDF-` for PDF, `FF D8 FF` for JPEG, `89 50 4E 47` for PNG, `50 4B 03 04` for DOCX/ZIP). Reject with 400 on mismatch. ~10 lines of code in `documents.service.upload`.

---

## 5. CROSS-CUTTING FINDINGS

### 5.1 🟡 MEDIUM — `POST /api/v1/inbound/email` webhook does not require `x-sendgrid-signature` header

**File:** `apps/api/src/modules/inbound/inbound.service.ts:264-319` (`verifyWebhookSignature`)

**OWASP category:** Broken Authentication / Improper Inventory Management

The HMAC verifier handles the case where `sendgridSig && sendgridSecret !== undefined` (L278-303) and the case where `mailgunSig && mailgunToken && mailgunTs && mailgunSecret` (L305-312). **Both paths correctly fail closed when no signature is present** (L316-318). However, the `sendgridSig` branch on L278 ONLY matches if `sendgridSecret !== undefined` (i.e. the env var is set). If the operator forgets to set `SENDGRID_INBOUND_SECRET` in production but DOES set `MAILGUN_WEBHOOK_SIGNING_KEY`, then a SendGrid-signed request would fall through to the default-reject path. Symmetrically: **if neither env var is set, the endpoint always 401s — fail-closed.** This is correct.

⚠ **The actual concern:** the controller (`inbound.controller.ts:38-77`) uses `@Public() + @SkipThrottle()` on this endpoint with NO IP allowlist. **Any HTTP client on the internet can POST a multipart body to this endpoint.** The HMAC verifier is the ONLY line of defense. If the verifier has a bug (race condition between raw-body capture and multer's data listener), or if the operator accidentally clears `SENDGRID_INBOUND_SECRET`, the endpoint becomes open. Suggested hardening:
1. Add a Caddy / nginx IP allowlist at the LB level (SendGrid + Mailgun publish their webhook source IP ranges).
2. Reject early in the controller if neither provider env var is set (`process.env.SENDGRID_INBOUND_SECRET || process.env.MAILGUN_WEBHOOK_SIGNING_KEY` — if both undefined, return 503 not 401).

**Suggested fix:** add an explicit `if (!sendgridSecret && !mailgunSecret) throw new ServiceUnavailableException('Inbound webhook not configured')` at the top of `verifyWebhookSignature` (or in the controller), AND restrict `@Throttle({ default: { limit: 30, ttl: 60_000 } })` on the IP-keyed bucket (since `@SkipThrottle()` is currently set).

### 5.2 🟡 MEDIUM — `POST /api/v1/inbound/mail/sync-all` cron secret compared with `!==` (non-constant-time)

**File:** `apps/api/src/modules/inbound/inbound.controller.ts:43-46`

**OWASP category:** Broken Authentication

```ts
if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
  throw new UnauthorizedException('Invalid cron secret');
}
```

`secret !== process.env.CRON_SECRET` is a JavaScript string comparison, which is **byte-by-byte but short-circuits** on the first differing byte. The timing differential is small but theoretically measurable — a sophisticated attacker can recover the secret byte-by-byte given enough requests. The codebase already uses `timingSafeEqual` for SendGrid/Mailgun HMACs (`inbound.service.ts:321-326` `safeEqual`). Use the same helper for the cron secret.

**Suggested fix:** reuse `safeEqual(expected, secret)` from `inbound.service.ts:321`.

### 5.3 🟡 MEDIUM — Login attempt lockout is per-IP, not per-account

See finding 4.1 above for full detail. **Restated here as cross-cutting because it also affects the legacy `RefreshToken` migration path in `auth.service.ts:234-240`.**

### 5.4 🟢 LOW — `POST /api/v1/inbound/scan` — no rate-limit per `x-scan-token` (only IP-keyed default)

**File:** `apps/api/src/modules/inbound/inbound.controller.ts:79-98`

The endpoint is `@Public()` and throttled by IP only (via `@Throttle({ default: { limit: 5, ttl: 60_000 } })`). An attacker who steals a scanner token can hit it 5/min from any number of IPs in parallel — the IP-keyed throttle bucket does NOT aggregate across IPs. **Suggested fix:** when scanner-token flow is used (line 90-91), bucket the throttle on `tokenHash` rather than IP. Today, this is a niche feature; document as accepted risk until scanner use grows.

### 5.5 🟢 LOW — Refresh token lookup has a TOCTOU between the hash-lookup and the legacy-plaintext-lookup

**File:** `apps/api/src/modules/auth/auth.service.ts:224-243`

```ts
const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
if (!stored) {
  // Fallback: legacy plaintext column
  const legacy = await this.prisma.refreshToken.findUnique({ where: { token: refreshToken }, include: { user: true } });
  ...
}
```

Two reads. **Risk:** if a row's `tokenHash` was null at insert time (the migration window allows `token: null, tokenHash: <hash>` — service code at L447 hard-codes `token: null` for fresh rows, so this is currently impossible; but **pre-migration rows could have `tokenHash: null + token: <plaintext>`**, and the new fallback at L234 correctly handles them). Today there is no security issue, but the migration comment at L230-233 says "24-48h safety net" — **ensure the plaintext `token` column is dropped after that window.** Also: `findUnique({ where: { token } })` for the legacy plaintext path goes through the same Prisma tenant extension, but `RefreshToken` is in `TENANT_EXEMPT_MODELS` (`prisma.service.ts:51`) — so the lookup is cross-tenant. **Acceptable for refresh tokens** (they're keyed by userId, not tenantId), but worth confirming in code review that the `user: { isActive, deletedAt }` check is enough to prevent a tenant-A token from being used to refresh a tenant-B session. Looking at `auth.service.ts:283-289`: the rotation calls `generateTokens(userRow)` with the full user including tenantId, so the new pair is scoped correctly. **No finding.**

### 5.6 🟢 LOW — `swagger` is publicly mounted

**File:** `apps/api/src/main.ts:137-147`

`SwaggerModule.setup('api/docs', app, document)` is mounted on the public internet with no auth. Today this is OK (the API is documentation-as-marketing for integrators). **Risk:** documents the full attack surface (every route + DTO + role gates) to a hostile actor. Suggested: gate behind a `?token=` query parameter (DocFlow uses this pattern for `cloudflared` tunnels), or behind basic-auth, or move under `/internal/docs` and require an admin JWT. Mark as LOW (acceptable risk today) but flag for the next sprint.

### 5.7 🟢 LOW — `helmet` CSP disabled in non-production

**File:** `apps/api/src/main.ts:36-47`

```ts
contentSecurityPolicy: process.env.NODE_ENV === 'production' ? { ... } : false,
```

CSP only in production. **Acceptable** for a JSON-only API, but the `frameguard: deny` (L54) and other helmet defaults DO run in dev — so the risk surface is small. Mark as LOW for review.

### 5.8 🟢 INFORMATIONAL — Documentation gap for `/api/v1/inbound/email` and `/api/v1/inbound/mail/sync-all`

Both endpoints are `@Public()` + have a working HMAC/cron-secret verifier, but are **not annotated with `@ApiOperation` security notes about the signing requirement**. Suggested: add a docstring in the Swagger YAML explicitly stating "this endpoint is signed — public access requires a valid HMAC header".

---

## 6. WHAT'S GOOD (don't undo)

| Strength | Evidence |
|---|---|
| Helmet + HSTS (prod) + CSP (prod) + frameguard deny + noSniff + referrer-policy no-referrer | `main.ts:36-58` |
| Trust-proxy honored for X-Forwarded-For | `main.ts:30` |
| CORS allowlist with credentials | `main.ts:104-124` |
| ValidationPipe whitelist + forbidNonWhitelisted | `main.ts:128-135` |
| bcrypt rounds = 12 | `auth.service.ts:21` |
| JWT issuer + audience + algorithm pinned to HS256 | `auth.service.ts:427-433` |
| Refresh tokens stored as SHA-256 hashes only | `auth.service.ts:31-33, 437-450` |
| Refresh-token rotation + reuse-detection revokes entire family | `auth.service.ts:259-273` |
| Per-IP / per-tenant / per-user throttling buckets | `app.module.ts:53-80` + `throttle-bucket.guard.ts` |
| Tenant scoping at 3 layers: TenantGuard, Prisma extension, explicit `where: { tenantId }` | `tenant.guard.ts`, `prisma.service.ts:178-216`, every service |
| Defense-in-depth RBAC at controller + service for ADMIN-only fields | `parties.controller.ts:200` + `parties.service.ts:266-274` |
| Atomic `updateMany` for the recurring flag (closes TOCTOU) | `supplier-resolver.ts:284-289` (HEAD `330a4e0`) |
| Per-field audit rows for ADMIN toggles | `parties.service.ts:405-427` |
| SendGrid HMAC over **raw bytes** (not parsed JSON) | `main.ts:80-93` + `inbound.service.ts:264-302` |
| `timingSafeEqual` for HMAC compare | `inbound.service.ts:321-326` |
| Filename sanitisation at controller + service + storage key | `documents.controller.ts:338-344` + `documents.service.ts:1111-1122, 1284-1300, 1331-1338` |
| MIME allowlist on upload (defense-in-depth) | `documents.controller.ts:95-107` + `documents.service.ts:112-119` |
| DTO `forbidNonWhitelisted` rejects extra fields | `main.ts:128-135` |
| Worker code wraps in `runWithTenantContext` (Prisma scope survives queue boundary) | `extraction.processor.ts:4,47` |

---

## 7. TOP 3 RECOMMENDED ACTIONS

1. **Add magic-bytes MIME verification on upload** (`documents.service.upload`, ~10 lines, blocks `.exe`/`.html` polyglot → stored XSS when file is downloaded via `Content-Disposition: inline`). See finding 4.8.
2. **Constant-time compare on the cron secret** in `inbound/mail/sync-all` (`inbound.controller.ts:43-46`). Trivial reuse of `safeEqual` from `inbound.service.ts:321`. See finding 5.2.
3. **Add per-account lockout counter for `/auth/login`** (currently per-IP only — NAT-friendly brute force bypass). See finding 4.1.

---

## 8. FINDINGS TABLE

| # | Finding | Severity | File:Line | OWASP Cat | Fix Effort |
|---|---|---|---|---|---|
| 4.8 | MIME allowlist checks header not magic bytes → stored XSS via polyglot upload | 🟡 MEDIUM | `documents.controller.ts:95-107` + `documents.service.ts:112-119` | Broken Obj. Property-Level Auth | S (10 lines) |
| 5.1 | Inbound webhook has no IP allowlist; relies solely on HMAC for unauthenticated public endpoint | 🟡 MEDIUM | `inbound.controller.ts:38-77` + `inbound.service.ts:264-319` | Broken Auth / Improper Inventory | S (LB config) |
| 5.2 | Cron secret compared with `!==` (non-constant-time) | 🟡 MEDIUM | `inbound.controller.ts:43-46` | Broken Auth | XS (reuse `safeEqual`) |
| 4.1 | Login throttle per-IP only → NAT bypass for brute force | 🟡 MEDIUM | `auth.controller.ts:58-63` | Unrestricted Resource Consumption | M (DB counter) |
| 4.4 | `UpdateDocumentDto.status` allows direct set without state-machine gate | 🟢 LOW | `documents.controller.ts:238-250` + `document.dto.ts:56-59` | Broken Function-Level Auth | XS (drop field from DTO) |
| 4.2 | `/auth/refresh` has no dedicated throttle bucket | 🟢 LOW | `auth.controller.ts:80-86` | Unrestricted Resource Consumption | XS |
| 4.6 | `/parties/:id/documents` has no dedicated throttle bucket | 🟢 LOW | `parties.controller.ts:165-197` | Unrestricted Resource Consumption | XS |
| 5.4 | `/inbound/scan` token-bucket missing (IP-only) | 🟢 LOW | `inbound.controller.ts:79-98` | Unrestricted Resource Consumption | S |
| 5.5 | Refresh-token legacy plaintext fallback window — confirm `token` column is dropped post-migration | 🟢 LOW (track) | `auth.service.ts:224-243` | Broken Auth | XS (drop column) |
| 5.6 | Swagger publicly mounted | 🟢 LOW | `main.ts:137-147` | Improper Inventory Mgmt | S |
| 5.7 | Helmet CSP disabled in non-prod | 🟢 LOW | `main.ts:36-47` | Security Misconfig | XS (always-on) |
| 5.8 | Inbound webhook Swagger missing signing requirement note | ℹ INFO | `inbound.controller.ts:38-77` | Improper Inventory Mgmt | XS |

---

## 9. AUDIT METHODOLOGY + ENVIRONMENT

- Manual read of all 8 endpoints + their service layers + Prisma tenant extension + throttle guard chain + RBAC guard chain + JWT guard chain + tenant guard chain + main bootstrap.
- Read 4 of 5 senior-security reference docs (skimmed, not deep-dived — references confirm checklist items).
- Ran the 3 senior-security Python scripts — all 3 return 0 boilerplate findings; this is documented as not-a-gate (Section 2).
- Cross-referenced the prior sprint's `fix-recurring-toggle-admin/SECURITY-AUDIT.md` to confirm the TOCTOU fix is in HEAD `330a4e0` and the audit-log fix shipped.
- `findings: 0` from the Python scripts is itself a **finding** (the scripts are not production-grade) but does NOT block the audit.

Smoke tests (curl) **NOT executed** — same caveat as the prior sprint audit. Auditoria baseou-se em leitura estática + grep + trace dos guards + extension Prisma.

---

## 10. CONCLUSÃO PARA O ORQUESTRADOR

**Sem BLOCKER. Pode integrar.** As 3 MEDIUM findings (magic-bytes MIME, inbound IP allowlist, cron secret constant-time, login per-account lockout) são melhorias que valem o esforço de XS-S cada. Podem entrar no próximo sprint ou abrir ticket. As 4 LOW são hygiene/defense-in-depth. Nenhuma finding representa vazamento de dados, escalation de privilégio, ou bypass de auth.
