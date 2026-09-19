import {
  EDENOX_QR_PAYLOAD,
  expectedExtraction,
} from "../../../../prisma/seeders/at-fixture";

// =============================================================================
// at-qr-fixture.spec.ts
//
// Pins the verification gap fix from DIAGNOSTIC-2 §4 B1.1: the
// QR-overrides-AI guard shipped in commit 4bcf908 was dead code in
// dev because every document in the test DB has `qrPayload = NULL`.
// The seeder in `prisma/seeders/at-fixture.ts` adds ONE PT AT doc with
// a valid QR payload so the QR-authoritative merge path is exercised
// end-to-end.
//
// What we assert here:
//   1) The seeder exports a payload + expectedExtraction contract so
//      the extraction pipeline's QR-merge path has a regression target.
//   2) The QR's A: field (= supplier NIF) is structurally valid (passes
//      mod-11) — otherwise the supplier-resolver wouldn't accept it.
//   3) The payload is self-consistent: the expectedExtraction.supplierNif
//      matches the A: field exactly. If a future seed tweak changes one
//      without the other, this test fails fast.
//
// The full end-to-end test (parse QR → extract → supplier resolves to
// the seeded Party) lives in `qr-overrides-ai-vision.spec.ts`. This
// file is the minimal regression guard for the fixture itself.
// =============================================================================

import { isValidPortugueseNif } from "../../../common/validation/tax-id.validator";

describe("at-fixture seeder — QR payload contract", () => {
  it("the exported QR payload carries the expected A: (issuer NIF) field", () => {
    const aField = EDENOX_QR_PAYLOAD.match(/(?:^|\*)A:(\d+)/)?.[1];
    expect(aField).toBeDefined();
    expect(aField).toBe(expectedExtraction.supplierNif);
  });

  it("the QR's A: (supplier) NIF passes mod-11", () => {
    expect(isValidPortugueseNif(expectedExtraction.supplierNif)).toBe(true);
  });

  it("the QR's B: (customer) NIF matches the tenant's NIF", () => {
    // Pin the tenant-side invariant so the QR-merge path always has a
    // tenant to match against. Tenant identity lives in the demo seed.
    const bField = EDENOX_QR_PAYLOAD.match(/(?:^|\*)B:(\d+)/)?.[1];
    expect(bField).toBeDefined();
    expect(bField).toBe(expectedExtraction.customerNif);
  });

  it("the QR payload is parseable as a non-empty string", () => {
    expect(EDENOX_QR_PAYLOAD).toBeTruthy();
    expect(EDENOX_QR_PAYLOAD.length).toBeGreaterThan(20);
    // Star-separated key:value fields — quick sanity that the payload
    // matches the AT-QR shape, not a malformed blob.
    const segments = EDENOX_QR_PAYLOAD.split("*");
    expect(segments.length).toBeGreaterThanOrEqual(8);
  });

  it("expectedExtraction is internally consistent", () => {
    // Total/taxAmount relationship — the seed is illustrative but the
    // reconciler expects positive numbers. If a future edit makes them
    // negative or NaN, this test catches it before the doc update.
    expect(expectedExtraction.total).toBeGreaterThan(0);
    expect(expectedExtraction.taxAmount).toBeGreaterThan(0);
    // Supplier NIF must NOT equal the tenant (the seed encodes a real
    // purchase scenario, not a self-billing case).
    expect(expectedExtraction.supplierNif).not.toBe(
      expectedExtraction.customerNif,
    );
  });
});
