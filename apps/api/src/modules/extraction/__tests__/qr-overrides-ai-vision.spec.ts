import {
  ExtractedFields,
  ExtractionService,
  StoragePort,
} from "../extraction.service";

// =============================================================================
// qr-overrides-ai-vision.spec.ts
//
// Real bug pinned here: 2026-09-06 — invoice `cmtoag5il000ng59oor229cb3`
// (filename: `NOV-OUSADO-LDA_2026-03-19_1018224984.pdf`) had
// supplier="NOV OUSADO LDA" with NIF 515208566, but the real supplier is
// EDENOX — EQUIPAMENTOS HOTELEIROS, LDA (NIF 502782160). Gemini Vision
// read the filename, mistook the customer for the supplier, and the QR
// was either absent or ignored. The safety net did not catch it because
// the supplier NAME did NOT match the tenant name substring-for-substring
// ("nov ousado unipessoal lda" does NOT include "nov ousado lda" as a
// substring — "unipessoal" sits in between).
//
// These tests pin the three fixes added to
// `ensureSupplierCustomerSanity` (CONDITION 4 + CONDITION 5):
//
//   1. QR A: field with valid NIF overrides the AI supplier NIF when
//      they disagree — AI NAME is cleared so the downstream
//      supplier-resolver can re-resolve via NIF lookup.
//   2. QR A: NIF that matches the tenant NIF (intercompany / swap bug)
//      still triggers the existing CONDITION 1 — supplier/customer swap.
//   3. AI supplier NAME that matches the upload filename prefix triggers
//      a swap (CONDITION 4) — the real bug from the EDENOX invoice.
//
// We invoke the private method via cast (matches the pattern in
// extraction.service.spec.ts) so we exercise the real logic without
// spinning up the full extraction pipeline.
// =============================================================================

const TENANT_ID = "tenant-qr-override";
// Real demo tenant identity from the bug report — kept in sync with the
// .env seed so the sanity helper's tenant-name match behaves like prod.
const TENANT_NAME = "NOV OUSADO UNIPESSOAL LDA";
const TENANT_NIF = "515208566";
const EDENOX_NIF = "502782160";

function buildService() {
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => ({ name: TENANT_NAME, nif: TENANT_NIF })),
      findFirst: jest.fn(async () => ({ name: TENANT_NAME, nif: TENANT_NIF })),
    },
  };
  const storage = {} as StoragePort;
  const svc = new ExtractionService(prisma as any, null, storage);
  return { svc, prisma };
}

const invoke = (
  svc: ExtractionService,
  fields: ExtractedFields,
  qrPayload?: string,
  fileName?: string,
): Promise<ExtractedFields> =>
  (svc as any).ensureSupplierCustomerSanity(
    TENANT_ID,
    fields,
    qrPayload,
    fileName,
  );

// AT-QR payload fixture — `A:` is the issuer (supplier) NIF, `B:` is the
// buyer (customer) NIF. Built from the spec at
// https://github.com/AT-QR-PT and pinned here so a future spec tweak that
// changes field positions is caught by the tests.
const EDENOX_QR =
  "A:502782160*B:515208566*C:PT*D:FT*E:N*F:20260319*G:FT 2026/7890*" +
  "H:EDENOX1234*I1:0*I2:571.96*I3:131.72*I4:0*J1:0*J2:0*J3:0*J4:0*" +
  "K1:0*K2:0*K3:0*K4:0*N:131.72*O:703.68*Q:abc*R:1";

describe("ensureSupplierCustomerSanity — QR overrides AI Vision", () => {
  it("Caso 1: QR A: NIF disagrees with AI supplier NIF → supplier NIF becomes QR's, AI NAME is cleared", async () => {
    // Mirrors the EDENOX invoice scenario, but with a QR available — the
    // post-fix happy path: AI wrote supplier=wrong name + wrong NIF, QR
    // A: says 502782160 (EDENOX), so we overwrite NIF and clear the
    // wrong NAME so supplier-resolver can re-resolve via the trusted NIF.
    const { svc } = buildService();
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.8,
      currency: "EUR",
      supplier: "EDENOX — EQUIPAMENTOS HOTELEIROS, LDA",
      supplierNif: "502782160", // AI got this right by coincidence
      customer: "NOV OUSADO UNIPESSOAL LDA",
      customerNif: TENANT_NIF,
      hints: [],
      warnings: [],
    };
    const out = await invoke(svc, fields, EDENOX_QR, "EDENOX-LDA_2026-03-19_1234.pdf");

    // QR's NIF is preserved (already matched), AI name still here because
    // it agreed with QR — CONDITION 5 only fires when they DISAGREE.
    expect(out.supplierNif).toBe(EDENOX_NIF);
    expect(out.supplier).toBe("EDENOX — EQUIPAMENTOS HOTELEIROS, LDA");
    // Customer untouched.
    expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
    expect(out.customerNif).toBe(TENANT_NIF);
  });

  it("Caso 2 (AI wrong + QR disagree): QR A: trumps the AI's wrong NIF + clears AI NAME", async () => {
    // The CONDITION 5 path. AI supplier NIF was wrong (some other NIF),
    // QR A: says EDENOX (502782160). After the fix the supplier NIF
    // becomes the QR's and the AI NAME is cleared so supplier-resolver
    // can re-resolve via the trusted NIF. We avoid feeding the test
    // supplierNif=TENANT_NIF because that would trip CONDITION 1 first
    // (the swap path), which is covered by Caso 3 below.
    const { svc } = buildService();
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.85,
      currency: "EUR",
      supplier: "EDENOX", // AI guessed a wrong name
      supplierNif: "999999990", // final-consumer placeholder, not the real supplier
      customer: "NOV OUSADO UNIPESSOAL LDA",
      customerNif: TENANT_NIF,
      iban: "PT50 0033 0000 4531 2966 5500 7",
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      EDENOX_QR,
      "NOV-OUSADO-LDA_2026-03-19_1018224984.pdf",
    );

    // CONDITION 5 fired: QR NIF took over, AI NAME discarded.
    expect(out.supplierNif).toBe(EDENOX_NIF);
    expect(out.supplier).toBeUndefined();
    expect(out.supplierVatId).toBeUndefined();
    // Customer kept untouched (the QR is only authoritative for the
    // SUPPLIER side; the customer side is the user's tenant).
    expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
    expect(out.customerNif).toBe(TENANT_NIF);
    // Hints surface the override for the audit trail + downstream re-resolve.
    const nifHint = out.hints?.find((h) =>
      h.startsWith("qrAuthoritativeSupplierNif:"),
    );
    expect(nifHint).toBe(`qrAuthoritativeSupplierNif:${EDENOX_NIF}`);
    const discardHint = out.hints?.find((h) =>
      h.startsWith("aiSupplierDiscarded:"),
    );
    expect(discardHint).toBe(
      "aiSupplierDiscarded:reason=qr_a_overrides_ai_supplier_nif",
    );
    // IBAN preserved (unrelated to supplier identification).
    expect(out.iban).toBe("PT50 0033 0000 4531 2966 5500 7");
  });

  it("Caso 3 (intercompany / swap bug): QR A: == tenant NIF triggers the existing supplier/customer swap", async () => {
    // The pre-existing CONDITION 1 must still work — when the QR says the
    // supplier IS the tenant, the AI must have swapped supplier and
    // customer. Pinning this guards against CONDITION 5 ever running
    // before CONDITION 1 in a way that swallows the swap.
    const { svc } = buildService();
    const intercompanyQr =
      `A:${TENANT_NIF}*B:502782160*C:PT*D:FT*E:N*F:20260319*G:FT 2026/1` +
      `*H:abcd*I1:0*I2:571.96*I3:131.72*I4:0*J1:0*J2:0*J3:0*J4:0` +
      `*K1:0*K2:0*K3:0*K4:0*N:131.72*O:703.68*Q:abc*R:1`;
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.8,
      currency: "EUR",
      // AI swapped — put tenant as supplier, real supplier as customer
      supplier: TENANT_NAME,
      supplierNif: TENANT_NIF,
      customer: "EDENOX — EQUIPAMENTOS HOTELEIROS, LDA",
      customerNif: EDENOX_NIF,
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      intercompanyQr,
      "EDENOX-LDA_2026-03-19_1234.pdf",
    );
    // Swap fired: tenant name → customer, EDENOX → supplier.
    expect(out.supplier).toBe("EDENOX — EQUIPAMENTOS HOTELEIROS, LDA");
    expect(out.supplierNif).toBe(EDENOX_NIF);
    expect(out.customer).toBe(TENANT_NAME);
    expect(out.customerNif).toBe(TENANT_NIF);
    const swap = out.hints?.find((h) =>
      h.startsWith("partySwap:reason=supplier_nif_eq_tenant_nif"),
    );
    expect(swap).toBeDefined();
    // CONDITION 5 must NOT have fired (qrAuthoritativeSupplierNif hint absent).
    expect(
      out.hints?.find((h) =>
        h.startsWith("qrAuthoritativeSupplierNif:"),
      ),
    ).toBeUndefined();
  });

  it("Caso 4 (NIF-anchored, root-cause fix): AI supplier NIF fails mod-11 + customer NIF passes + NIFs swapped → swap supplier↔customer (filename heuristic is no longer required)", async () => {
    // DIAGNOSTIC-2 §5 item 6 — Sprint H+ extraction-fix-3.
    //
    // The OLD predicate was `filenameSuspiciousMatch || (structuralNifMismatch && filenameSuspiciousMatch)`,
    // i.e. the structural NIF check was gated behind the filename
    // heuristic. When the AI hallucinated a supplier name NOT present in
    // the filename (the user's "10× the same PDF" pattern), none of the
    // guards fired. The root-cause fix drops the filename gating from
    // the structural path: we now swap whenever supplier NIF fails mod-11
    // AND customer NIF passes mod-11, regardless of filename.
    //
    // This test was previously named "Caso 4 (filename heuristic, defense
    // in depth)" and used `supplierNif: "999999990"` (mod-11 valid final-
    // consumer placeholder) so the structural check would NOT fire and
    // only the filename heuristic would swap. After the root-cause fix
    // the filename-only path is gone, so the old fixture would no longer
    // swap. The new fixture uses `supplierNif: "100000000"` (mod-11
    // invalid) so the structural check fires — and the supplier name does
    // NOT match the filename, exactly the previously-missed bug case.
    const { svc } = buildService();
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.85,
      currency: "EUR",
      // Supplier name does NOT match filename — the previously-missed
      // bug case (filename heuristic was gated behind the filename
      // anchor, so this scenario used to escape the safety net).
      supplier: "SOME VENDOR WE NEVER HEARD OF",
      supplierNif: "100000000", // mod-11 INVALID — forces structuralNifMismatch
      customer: "NOV OUSADO UNIPESSOAL LDA",
      // Customer NIF passes mod-11. Distinct from the tenant's NIF so the
      // CONDITION 4 outer-gate `customerNif !== tenantNif` doesn't reject
      // the swap. `510000002` is mod-11 valid (sum=2, mod=2, expected=9,
      // check digit=2 — verifiable with `isValidPortugueseNif`).
      customerNif: "510000002",
      iban: "PT50 0033 0000 4531 2966 5500 7",
      hints: [],
      warnings: [],
    };
    // Filename deliberately does NOT match the supplier name — the
    // scenario that the old filename-anchored guard missed. The new
    // NIF-anchored guard catches it.
    const out = await invoke(
      svc,
      fields,
      undefined,
      "random-november-receipt.pdf",
    );
    // Swap fired via the NIF-anchored structural check.
    expect(out.supplier).toBe("NOV OUSADO UNIPESSOAL LDA");
    expect(out.supplierNif).toBe("510000002");
    expect(out.customer).toBe("SOME VENDOR WE NEVER HEARD OF");
    expect(out.customerNif).toBe("100000000");
    const swap = out.hints?.find((h) =>
      h.startsWith("partySwap:reason=ai_supplier_name_matches_filename_prefix"),
    );
    expect(swap).toBeDefined();
  });

  it("Caso 5 (sanity): AI supplier NAME matches filename BUT customer slot has no valid NIF → no swap (avoid losing info)", async () => {
    // Guards CONDITION 4 against false positives. When customer slot has
    // no NIF (or its NIF IS the tenant), we don't have anything to swap
    // into — we let the existing pipeline flag `supplierReview=true`
    // instead. Mirrors the existing `hasCustomerData` guard pattern.
    const { svc } = buildService();
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.6,
      currency: "EUR",
      supplier: "NOV OUSADO LDA",
      customer: "EDENOX", // no NIF — can't verify it's not us
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      undefined,
      "NOV-OUSADO-LDA_2026-03-19_1234.pdf",
    );
    // NO swap (no customer NIF to swap into).
    expect(out.supplier).toBe("NOV OUSADO LDA");
    expect(out.customer).toBe("EDENOX");
    expect(
      out.hints?.find((h) => h.startsWith("partySwap:")),
    ).toBeUndefined();
  });

  it("Caso 6 (sanity): CONDITION 5 fires only when QR is present — without QR it does nothing", async () => {
    // If the QR didn't decode, the helper has no authoritative NIF to
    // override with. This test pins that behaviour so a future refactor
    // can't accidentally fall back to fields.supplierNif (which would
    // reintroduce the bug).
    const { svc } = buildService();
    const fields: ExtractedFields = {
      source: "ai",
      confidence: 0.8,
      currency: "EUR",
      supplier: "EDENOX — EQUIPAMENTOS HOTELEIROS, LDA",
      supplierNif: EDENOX_NIF,
      customer: "NOV OUSADO UNIPESSOAL LDA",
      customerNif: TENANT_NIF,
      hints: [],
      warnings: [],
    };
    const out = await invoke(
      svc,
      fields,
      undefined, // no QR
      "EDENOX-LDA_2026-03-19_1234.pdf",
    );
    // Fields untouched.
    expect(out.supplierNif).toBe(EDENOX_NIF);
    expect(out.supplier).toBe("EDENOX — EQUIPAMENTOS HOTELEIROS, LDA");
    expect(
      out.hints?.find((h) =>
        h.startsWith("qrAuthoritativeSupplierNif:"),
      ),
    ).toBeUndefined();
  });
});
