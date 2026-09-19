# Sprint G — Party 360° file — SECURITY AUDIT

**Auditor:** security-auditor (Opus 5)
**Branch:** main · **HEAD:** 0227a01
**Scope:** commit `11d109f` (Sprint G backend — 13 files, +1558/-6 LOC)
**Verdict:** **READY TO MERGE** — 0 BLOCKER, 4 advisory findings, no HIGH.

---

## Skills loaded

- `oc-api-audit` → loaded, applied §1–13.
- `oc-billing-webhooks` → loaded, applied §1–8 (only §7 *tenant isolation on routing* is materially relevant here; there is no inbound webhook surface in this sprint).

---

## oc-api-audit — checklist walkthrough

### §1 BOLA (OWASP API1) — Broken Object Level Authorization

| Surface | Verdict | Evidence |
|---|---|---|
| `PartyContactsController.list/create/update/remove` | PASS | `party-contacts.service.ts:46,69,105,171` — every Prisma call has `where: { tenantId, partyId }` derived from `user.tenantId` (session) and `req.params.partyId`. `assertPartyInTenant` (L195–201) runs BEFORE any contact read/write and returns 404 for cross-tenant access (does not leak whether party exists in another tenant). |
| `PartyAddressesController.list/create/update/remove` | PASS | `party-addresses.service.ts:65,102,135,166,205,249,307` — `tenantId` injected on every Prisma `findFirst/update/updateMany/delete`. `assertPartyInTenant` (L331–337) gates all paths. |
| `PartyPaymentsController.list` | PASS | `party-payments.service.ts:43` — `where: { tenantId, document: { partyId, tenantId } }`. The JOIN through `Document.partyId` includes `document: { tenantId }` so cross-tenant partyIds can't be probed. |
| `PartyTimelineController.list` | PASS | `party-timeline.service.ts:87,97,111,120` — all 4 sources carry `tenantId`; the audit/payment/iban/document `findMany` calls all include the tenant predicate. |
| PATCH/DELETE on `/:id` | PASS | Both `party-contacts.service.ts:105` and `party-addresses.service.ts:166,307` do `findFirst({ where: { id, tenantId, partyId } })` BEFORE any update/delete. Cross-tenant IDs return 404 (no existence oracle). |

### §2 BFLA (OWASP API2) — Broken Function Level Authorization

| Surface | Verdict | Evidence |
|---|---|---|
| `POST/PATCH/DELETE /parties/:partyId/contacts` | PASS | `party-contacts.controller.ts:62,77,91` — `@Roles(Role.ADMIN)` decorator applied to every mutation. `RbacGuard` is registered globally (`app.module.ts:144`). |
| `POST/PATCH/DELETE /parties/:partyId/addresses` | PASS | `party-addresses.controller.ts:61,75,88` — same `@Roles(Role.ADMIN)` pattern. |
| `GET /contacts`, `/addresses`, `/payments`, `/timeline` | PASS | No `@Roles` (intentional) — gated only by `JwtGuard` + `TenantGuard` (tenant-scope comes from `req.user.tenantId`). This is the same pattern as `GET /parties/:id/iban-history` and `GET /parties/:id/documents` (Sprint E precedent). |
| Anonymous allowlist | N/A | No new `@Public()` routes in this sprint — no auth bypass introduced. |
| Roles from session, not body | PASS | `Role` enum read from JWT claims by `RbacGuard`; controller never reads roles from body/query. |

### §3 Mass Assignment (OWASP API6)

| Surface | Verdict | Evidence |
|---|---|---|
| Global ValidationPipe | PASS | `main.ts:130–133` — `whitelist: true, forbidNonWhitelisted: true, transform: true`. Sprint G inherits this; extra fields like `tenantId`, `id`, `partyId` posted in body are silently dropped (whitelist) and unknown fields trigger a 400 (forbidNonWhitelisted). |
| `CreatePartyContactDto` | PASS | `party-contact.dto.ts:28–60` — every field has `@IsString` / `@IsEmail` / `@MaxLength` / `@Matches` (phone format). No `@Expose` without `@IsXxx`. `normalizeEmail` transform collapses empty strings to `undefined` so the unique index doesn't conflict. |
| `CreatePartyAddressDto` | PASS | `party-address.dto.ts:20–74` — `@IsEnum(PartyAddressType)` for `type`, `@IsString` + `@MaxLength` for all string fields, `@Matches` for postal code, `@IsBoolean` for `isPrimary`, country upper-cased via `Transform`. |
| `@Body()` typed | PASS | Every controller signature receives a typed DTO (`@Body() dto: CreatePartyContactDto` etc.) — no raw `body` reference. |
| `tenantId` injection | PASS | DTOs have no `tenantId` field; whitelist ensures it is dropped even if posted. `tenantId` is sourced from `req.user.tenantId` server-side only (`party-contacts.service.ts:69`, `party-addresses.service.ts:102,135`). |

### §4 Unrestricted Resource Consumption (OWASP API4)

| Surface | Verdict | Evidence |
|---|---|---|
| Global Throttler | PASS | `app.module.ts:56–77` — `ThrottlerModule.forRoot([...])` with `short/medium/long` buckets, applied globally via `APP_GUARD` (`ThrottleBucketGuard`, line 144). |
| Per-endpoint throttle on Contacts/Addresses POST/PATCH/DELETE | **ADVISORY §4-A** | None of the new mutation routes carry an `@Throttle(...)` override. The global buckets are shared with all user-facing routes, so a noisy script can hit the contacts/addresses endpoints at the long-window cap (100/60s by default). For "master data" CRUD this is acceptable, but worth knowing — see advisory below. |
| Payments/Timeline pagination cap | PASS | `party-payments.service.ts:40` — `Math.min(Math.max(limit, 1), 50)` caps `take` at 50. `party-timeline.service.ts:60` — same cap + per-source `take: 200` defensive bound. |
| Cursor DoS on Timeline | PASS | `party-timeline.service.ts:60,93,102,116,126` — `safeLimit` clamped to 1..50, per-source `take: 200` keeps the worst case bounded for very busy tenants. |
| Bad input on Payments limit | PASS | `party-payments.controller.ts:53–59` and `party-timeline.controller.ts:52–58` — `Number.isFinite` guards `NaN/Infinity` and falls back to `20`. |

### §5 SSRF (OWASP API7)

N/A — Sprint G introduces no outbound HTTP / extraction / webhook ingest. No new surface.

### §6 Security Misconfiguration (OWASP API8)

| Surface | Verdict | Evidence |
|---|---|---|
| `helmet()` | PASS | `main.ts:36` — registered. |
| CORS allowlist | PASS | `main.ts:104–110` — comma-separated env, refuses `*` unless explicit. |
| Global exception filter | PASS (inherited) | Existing filter sanitises Prisma errors to user-safe messages (referenced in `party-contacts.service.ts:232–244` which maps `P2002` to `ConflictException` with PT message — no raw `Prisma.PrismaClientKnownRequestError` reaches the client). |
| Health/dev routes gating | N/A | Sprint G did not touch health or dev routes. |

### §7 Improper Inventory Management (OWASP API9)

| Surface | Verdict | Evidence |
|---|---|---|
| OpenAPI decorators | PASS | Every new controller method carries `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse` (`party-contacts.controller.ts`, `party-addresses.controller.ts`, `party-payments.controller.ts`, `party-timeline.controller.ts`). Generated spec will include the new routes. |
| Deprecated routes | N/A | No routes deprecated in this sprint. |
| Versioning | PASS | All new routes sit under the existing `/parties/:partyId/...` prefix inherited from the global `/api/v1`. |

### §8 Input Validation (OWASP API10)

| Surface | Verdict | Evidence |
|---|---|---|
| Email format | PASS | `party-contact.dto.ts:43` — `@IsEmail({}, { message: 'Email inválido' })`. |
| Phone format (PT-tolerant) | **ADVISORY §8-A** | `party-contact.dto.ts:50–52` — `@Matches(/^[+0-9 ()\-]{4,30}$/)`. Permissive: accepts any combination of digits / spaces / `+` / `-` / parentheses, e.g. `++++`, `()(())`, or spaces-only `    ` would pass. Real PT format would narrow further (e.g. require at least 9 digits). Low-severity because the field is free-text in this domain — flag for tightening in a follow-up. |
| Postal code format | **ADVISORY §8-A** | `party-address.dto.ts:42–44` — `@Matches(/^[0-9A-Za-z\- ]{3,20}$/)` accepts e.g. `---` or `   ` (spaces only). No country-aware format enforcement. |
| `line1` max length | PASS | `party-address.dto.ts:30–31` — `@MaxLength(255)`. |
| Country code | PASS | `party-address.dto.ts:60–64` — `@MaxLength(2)` + `Transform` upper-cases the value. CAVEAT: not validated against the ISO 3166-1 list (a typo `XX` would be accepted) — see advisory §13-A. |
| Magic-bytes file upload | N/A | No file uploads added. |

### §9 Audit Log Coverage (Sprint B pattern)

| Surface | Verdict | Evidence |
|---|---|---|
| Contact create | PASS | `party-contacts.service.ts:78–85` — `AuditAction.CREATE` with `entityType: 'party_contact'`, `metadata: { partyId, name, email }`. |
| Contact update | PASS | `party-contacts.service.ts:142–154` — per-field `AuditAction.EDIT` rows with `subAction: 'party.update.contact'`, `field`, `oldValue`, `newValue`. Skips unchanged fields (L139–141). |
| Contact delete | PASS | `party-contacts.service.ts:177–184` — `AuditAction.DELETE` with `entityType: 'party_contact'`. |
| Address create | PASS | `party-addresses.service.ts:134–146` — `AuditAction.CREATE`, includes `type`, `isPrimary`, `country`. |
| Address update (fast-path) | PASS | `party-addresses.service.ts:204–210` + helper `auditFieldChanges` (L370–398) — per-field `AuditAction.EDIT` for `line1/line2/postalCode/city/country`. |
| Address update (type/isPrimary flip) | PASS | `party-addresses.service.ts:278–292` — `AuditAction.EDIT` with `subAction: 'party.update.address'`, captures `oldType/newType` and `oldIsPrimary/newIsPrimary`. |
| Address delete | PASS | `party-addresses.service.ts:313–325` — `AuditAction.DELETE` with `type`, `isPrimary`, `line1`. |
| Audit write-once | PASS | Inherited from `AuditService`; Sprint G only calls `.log(...)` — never mutates existing rows. |

### §10 Token Handling

N/A — Sprint G does not touch auth, refresh, or OAuth.

### §11 File System Security

N/A — Sprint G adds no file uploads, no storage relocation, no path handling.

### §12 Race Conditions

| Surface | Verdict | Evidence |
|---|---|---|
| `PartyAddress.isPrimary` invariant | PASS | `party-addresses.service.ts:86–132` (create), `229–276` (update) — `pg_advisory_xact_lock(hashtext('party_address_primary:' || partyId || ':' || type))` taken inside `prisma.$transaction` on both POST and PATCH (slow-path). Two concurrent `setPrimary(type=BILLING)` requests serialise on the lock; the second waits until the first commits, then its `updateMany({ NOT: { id } })` correctly demotes any other primary. **Note:** if PATCH is changing `type` from `CORRESPONDENCE → BILLING` and demoting the old row to non-primary, the lock is taken on the **NEW** type only — concurrent flips to the OLD type will not serialise. Acceptable trade-off because the OLD-type row is leaving the type anyway. |
| Contact unique-email race | PASS | `@@unique([tenantId, partyId, email])` (`migration.sql:70`) — DB-level constraint rejects the second insert; service maps `P2002` → `ConflictException` (`party-contacts.service.ts:238–242`). No app-level TOCTOU window. |
| Counter increments / IBAN flag toggles | N/A | Sprint G does not touch those. |
| Optimistic update pattern | N/A | `updateMany({ where: { ... } })` used only for the "unset other primaries" pattern under the advisory lock — race-safe. |

### §13 Information Disclosure

| Surface | Verdict | Evidence |
|---|---|---|
| `sanitizePartyContact` strips `tenantId` | PASS | `party-contacts.service.ts:207–227` — explicit allow-list; `tenantId` is NOT in the returned shape. |
| `sanitizePartyAddress` strips `tenantId` | PASS | `party-addresses.service.ts:339–363` — same pattern. |
| `sanitizeParty` strips nested tenantId | PASS | `parties.service.ts:1137–1180` — `contacts`/`addresses` mapping explicitly omits `tenantId` and `tenant`. |
| Timeline response leaks PII | PASS | `party-timeline.service.ts:140–175` — only the audit event's `userId` and `metadata` are returned. IBAN change events expose `oldIban/newIban` but the same IBAN is already visible on the Party record (master data); no worse than current. |
| Payment events expose `amount` | PASS | Already master-data visible via Documents list. No sensitive PII (card numbers, etc.) in the timeline shape. |
| Document `fileKey` in payments/timeline | **ADVISORY §13-A** | `party-payments.service.ts:48` and `party-timeline.service.ts:105` both `include: { document: { select: { id, docNumber, fileKey } } }`. `fileKey` is the internal storage path (e.g. `<tenant>/<year>/<month>/<id>.pdf`). Exposing it to the UI is fine for fetching, but it leaks the tenant's folder layout if the document response is ever cached at an edge. Not strictly a leak under BOLA (tenant-scoped), but worth confirming the front-end never reflects this field back as a URL — pattern check suggested. |
| ISO-3166 country validation | **ADVISORY §13-A** | `party-address.dto.ts:60–64` — country code is only upper-cased and length-capped; not validated against the ISO 3166-1 alpha-2 set. A typo `XX` would persist and reach the UI as a flag emoji (lib flag-icons may render `XX` as unknown or fall back). Cosmetic risk — not a security issue, but flag for UX consistency. |
| Global exception filter | PASS (inherited) | Prisma errors mapped to user-safe messages; `party-contacts.service.ts:233–244` shows the pattern explicitly. |

---

## oc-billing-webhooks — checklist walkthrough

The only section that materially applies here is §7 *Tenant Isolation on Routing* (the rest are webhook-only and N/A).

| § | Verdict | Evidence |
|---|---|---|
| §7 Tenant isolation | PASS | Every new endpoint derives `tenantId` from the JWT session and uses it as the primary filter on every Prisma call. No payload-supplied `tenantId` is trusted. `assertPartyInTenant` returns 404 for cross-tenant access (no existence oracle). The 4-source Timeline JOIN includes `document: { partyId, tenantId }` so cross-tenant `partyId` cannot be probed via a PaymentEvent reference. |

---

## Findings summary

| ID | Severity | OWASP | Topic | Evidence |
|---|---|---|---|---|
| §4-A | advisory | API4 | No per-endpoint `@Throttle` on contacts/addresses POST/PATCH/DELETE | `party-contacts.controller.ts`, `party-addresses.controller.ts` — no `@Throttle` decorator. Global bucket (100/60s) is the only defence. |
| §8-A | advisory | API10 | Phone + postal code regex is permissive (accepts empty-shape strings) | `party-contact.dto.ts:50–52`, `party-address.dto.ts:42–44` |
| §13-A | advisory | API13 | `document.fileKey` exposed in payments + timeline payloads; country code not ISO-3166-1-validated | `party-payments.service.ts:48`, `party-timeline.service.ts:105`, `party-address.dto.ts:60–64` |

**No BLOCKER. No HIGH.**

---

## Tests required

None — existing test coverage (`party-contacts-crud.spec.ts`, `party-addresses-crud.spec.ts`, `party-addresses-primary-constraint.spec.ts`, `timeline-aggregation.spec.ts`, `timeline-cursor.spec.ts`) covers the audit checklist. Recommend adding:

1. **Cross-tenant probe test** — admin in tenant A attempts `GET /parties/<tenant-B-partyId>/contacts`, `…/addresses`, `…/payments`, `…/timeline` and asserts 404 (not 403, to avoid existence oracle).
2. **Mass-assignment test** — POST `/contacts` and `/addresses` with body `{ "tenantId": "<other>", "id": "x" }` and assert the response `tenantId` is from session, not the body.
3. **Throttle regression** — once the global throttle bucket defaults are tuned, add a low-cost test that confirms contacts/addresses POSTs still receive `429` after the configured cap.

---

## Verdict

**READY TO MERGE.** Sprint G follows the established DocFlow security patterns faithfully:
- BOLA closed via `assertPartyInTenant` + `where: { tenantId, partyId }` on every query.
- BFLA closed via `@Roles(Role.ADMIN)` on all mutations; GETs rely on JWT + tenant scope.
- Mass assignment closed by global ValidationPipe (`whitelist + forbidNonWhitelisted`) and absence of `tenantId` in DTOs.
- Audit log covers every mutation with `CREATE/EDIT/DELETE` and per-field `oldValue/newValue` rows.
- Race condition on `PartyAddress.isPrimary` correctly handled with `pg_advisory_xact_lock`.
- Information disclosure handled via per-resource `sanitize*` helpers that explicitly drop `tenantId`.

The 3 advisory items are quality improvements, not blockers — recommended to file as a Sprint G.2 follow-up backlog item.
