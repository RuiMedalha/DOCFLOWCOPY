import { ExtractionService } from "../extraction.service";

/**
 * Fase 2 — an LLM-read QR payload is only promoted to QR authority when it
 * agrees with the structured fields the same LLM extracted. Seen in the
 * production benchmark: hallucinated NIF 507097823 (valid check digit) for
 * 507397823, and total 5.20 on a 38.10 receipt.
 */
describe("ExtractionService.isAiQrConsistent() — Fase 2", () => {
  const svc = new ExtractionService({} as any, null, null);

  it("accepts when NIF, total and date agree", () => {
    const out = svc.isAiQrConsistent(
      { supplierNif: "507397823", total: 38.1, docDate: "2026-06-30" },
      { supplierNif: "PT507397823", total: 38.1, docDate: "2026-06-30" },
    );
    expect(out).toEqual({ ok: true, reasons: [] });
  });

  it("rejects a NIF mismatch even when the check digit is valid", () => {
    const out = svc.isAiQrConsistent(
      { supplierNif: "507097823", total: 175.15, docDate: "2026-07-04" },
      { supplierNif: "507397823", total: 175.15, docDate: "2026-07-04" },
    );
    expect(out.ok).toBe(false);
    expect(out.reasons).toEqual(["nif:507097823!=507397823"]);
  });

  it("rejects a total mismatch", () => {
    const out = svc.isAiQrConsistent(
      { supplierNif: "507397823", total: 5.2 },
      { supplierNif: "507397823", total: 38.1 },
    );
    expect(out.ok).toBe(false);
    expect(out.reasons[0]).toMatch(/^total:/);
  });

  it("rejects a QR without NIF or total", () => {
    expect(svc.isAiQrConsistent({ supplierNif: "507397823" }, { total: 1 }).ok).toBe(false);
    expect(svc.isAiQrConsistent({ total: 1 }, { supplierNif: "507397823" }).ok).toBe(false);
  });

  it("tolerates missing AI fields (nothing to compare against) but still needs NIF + total in the QR", () => {
    expect(svc.isAiQrConsistent({ supplierNif: "507397823", total: 10 }, {}).ok).toBe(true);
  });
});
