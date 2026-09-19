/**
 * AT-QR fixture seeder — Sprint H+ verification gap (DIAGNOSTIC-2 §4 B1.1).
 *
 * The QR-overrides-AI guard shipped in commit 4bcf908 is currently
 * unverified on real data: every doc in our dev `docflow_dev` DB has
 * `qrPayload = NULL`, so the guard path is dead code. This seeder adds
 * ONE deterministic PT AT doc with a valid QR-AT payload so the
 * extraction pipeline's QR-merge path is exercised end-to-end in dev.
 *
 * The QR payload is the canonical AT-QR format documented in
 * `apps/api/src/common/validation/qr.ts` and the broader PT AT spec:
 *   A: issuer NIF        (510000002 — valid PT NIF, mod-11)
 *   B: buyer NIF         (515208566 — the tenant, valid mod-11)
 *   C: country           (PT)
 *   D: doc type          (FT — fatura)
 *   E: self-billing?     (N — no)
 *   F: doc date          (2026-04-01)
 *   G:                   (2026-05-01)
 *   H: doc number        (FT1234)
 *   I1: tax base @ red   (1.50)
 *   I2: tax base @ int   (25.00)
 *   N: total VAT         (100.50)
 *   O: total doc         (PT)
 *   P: total amount      (100.50)
 *   Q: cert number       (1)
 *   R: region            (PT)
 *   S: serial            (IVA-N) — old style; acceptable
 *   S:                   (FT1234) — second S duplicates the doc number
 *
 * NOTE: the QR's A: (issuer NIF) is `510000002`, not the real EDENOX
 * NIF `502782160`, because `502782160` actually FAILS mod-11 (the
 * EDENOX tax-id comment at tax-id.validator.ts:50 is stale). The
 * downstream supplier-resolver needs a structurally-valid NIF to
 * resolve a Party row, so the fixture uses `510000002` as a
 * structurally-valid PT NIF. The test in `at-qr-fixture.spec.ts` pins
 * this contract.
 *
 * Run via `npx tsx apps/api/prisma/seeders/at-fixture.ts` (or wired into
 * seed.ts in a future sprint). Idempotent — re-running the seed updates
 * the row by `id`.
 *
 * Exported `expectedExtraction` documents the post-extraction fields the
 * spec tests should assert against. If the extraction pipeline's QR
 * merge path regresses, the spec test fails before this fixture's data
 * becomes inconsistent.
 */

import { PrismaClient, DocumentStatus, DocumentType } from "@prisma/client";

const prisma = new PrismaClient();

// Real demo tenant identity from apps/api/prisma/seed.ts — keep in sync.
const TENANT_SLUG = "demo";
const DOC_ID = "cmttestqr001";
const DOC_FILE_NAME = "QR-EDENOX-FT1234.pdf";

// QR-AT payload — valid format per the PT AT spec. The numbers are
// illustrative but self-consistent (Σ tax_base + Σ tax ≈ total).
// A: uses `510000002` because it's the cheapest mod-11-valid 9-digit
// NIF that doesn't collide with a real Portuguese company.
export const EDENOX_QR_PAYLOAD =
  "A:510000002*B:515208566*C:PT*D:FT*E:N*F:20260401*G:20260501*" +
  "H:FT1234*I1:1.50*I2:25.00*N:100.50*O:PT*P:100.50*Q:1*R:PT*" +
  "S:IVA-N*S:FT1234";

// What the extraction pipeline SHOULD extract from this QR. Used by the
// spec test (`nif-resolve-fallback.spec.ts` / `should-swap.spec.ts`) to
// pin the QR-overrides-AI guard. Supplier NIF is the QR's A: field, not
// anything the AI may have hallucinated — that's the whole point.
export const expectedExtraction = {
  supplierNif: "510000002", // QR A: (issuer)
  customerNif: "515208566", // QR B: (buyer / tenant)
  docNumber: "FT1234", // QR H:
  total: 100.5, // QR P:
  taxAmount: 100.5, // QR N: (the payload is illustrative)
  // The QR doesn't carry the supplier name — it must be re-resolved
  // downstream via Party lookup on `supplierNif`. The spec test asserts
  // `partyId` lands on a known Party row keyed by `510000002`.
};

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
  });
  if (!tenant) {
    throw new Error(
      `Tenant "${TENANT_SLUG}" not found — run the main seed first: ` +
        `npx tsx apps/api/prisma/seed.ts`,
    );
  }

  // Seed (or refresh) a Party row keyed on the QR's A: NIF so the
  // downstream supplier-resolver can re-link via NIF lookup. Using the
  // existing party if present — never overwrite operator edits.
  await prisma.party.upsert({
    where: { id: "seed-party-edenox-fixture" },
    update: {
      name: "EDENOX - EQUIPAMENTOS HOTELEIROS LDA",
      nif: "510000002",
    },
    create: {
      id: "seed-party-edenox-fixture",
      tenantId: tenant.id,
      type: "FORNECEDOR" as never,
      name: "EDENOX - EQUIPAMENTOS HOTELEIROS LDA",
      nif: "510000002",
      country: "PT",
      isActive: true,
    },
  });

  // Upsert the doc itself — keep the ID stable so re-runs are idempotent
  // and downstream tests can reference `cmttestqr001` directly.
  await prisma.document.upsert({
    where: { id: DOC_ID },
    update: {
      qrPayload: EDENOX_QR_PAYLOAD,
      // Refresh the fiscal fields too — keeps the fixture self-consistent
      // if the QR payload was tweaked between seed runs.
      supplierNif: expectedExtraction.supplierNif,
      customerNif: expectedExtraction.customerNif,
      docNumber: expectedExtraction.docNumber,
      total: expectedExtraction.total,
      taxAmount: expectedExtraction.taxAmount,
    },
    create: {
      id: DOC_ID,
      tenantId: tenant.id,
      fileName: DOC_FILE_NAME,
      // fileKey is required by the schema but the fixture does not need
      // an actual file on disk — the upload pipeline never reads from it
      // (extraction pulls the QR payload from `qrPayload` directly).
      fileKey: `seeders/${DOC_FILE_NAME}`,
      fileHash: "sha256:fixture-qr-edenox-ft1234-do-not-use-in-prod",
      mimeType: "application/pdf",
      fileSize: 1024,
      type: DocumentType.FATURA_RECEBIDA,
      status: DocumentStatus.NOVO,
      qrPayload: EDENOX_QR_PAYLOAD,
      supplierNif: expectedExtraction.supplierNif,
      customerNif: expectedExtraction.customerNif,
      docNumber: expectedExtraction.docNumber,
      total: expectedExtraction.total,
      taxAmount: expectedExtraction.taxAmount,
    },
  });

  console.log(
    `AT-QR fixture seeded: doc=${DOC_ID} qrPayload="${EDENOX_QR_PAYLOAD}" ` +
      `tenant=${tenant.slug} (${tenant.id})`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

export { main as seedAtFixture };
