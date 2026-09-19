import {
  classifyFiscalStatus,
  detectNonFiscalKind,
  isSyntacticallyValidEuVat,
  isValidAtQr,
  normalizeDocNumber,
} from "../fiscal-status";

const VALID_QR = {
  issuerNif: "500842019",
  atcud: "J66V9C9T-6384",
  hash4: "AbCd",
  softwareCert: "0006",
  documentType: "FT",
};

describe("Fase 3 — fiscal status rules (deterministic)", () => {
  it("FISCAL when the AT-QR is valid (NIF mod-11 + ATCUD + Q + R)", () => {
    const out = classifyFiscalStatus({ qr: VALID_QR, qrOrigin: "zxing" });
    expect(out.fiscalStatus).toBe("FISCAL");
    expect(out.reason).toMatch(/^qr_at_valid/);
    expect(out.documentType).toBeUndefined();
  });

  it("FS in the QR marks the document as FATURA_SIMPLIFICADA", () => {
    const out = classifyFiscalStatus({ qr: { ...VALID_QR, documentType: "FS" }, qrOrigin: "pdf-text" });
    expect(out).toMatchObject({ fiscalStatus: "FISCAL", documentType: "FATURA_SIMPLIFICADA" });
  });

  it("a valid QR beats non-fiscal keywords (real invoices mention 'orçamento nº' as a reference)", () => {
    const out = classifyFiscalStatus({ qr: VALID_QR, qrOrigin: "zxing", text: "Fatura FT 1/2 — Ref. Orçamento nº 55" });
    expect(out.fiscalStatus).toBe("FISCAL");
  });

  it.each([
    ["FATURA PRO-FORMA nº 12", "PROFORMA"],
    ["Proforma Invoice #A-1", "PROFORMA"],
    ["ORÇAMENTO Nº 2026/44", "ORCAMENTO"],
    ["Quotation no. 7 for the client", "ORCAMENTO"],
    ["Aviso de Pagamento — vencimento 2026-10-01", "AVISO_PAGAMENTO"],
    ["Extrato de conta corrente do fornecedor", "EXTRATO_FORNECEDOR"],
    ["Account Statement — March", "EXTRATO_FORNECEDOR"],
  ])("NAO_FISCAL by keyword: %s → %s", (text, kind) => {
    const out = classifyFiscalStatus({ text, supplierNif: "500842019", docNumber: "1", docDate: "2026-01-01" });
    expect(out).toMatchObject({ fiscalStatus: "NAO_FISCAL", documentType: kind, reason: `keyword:${kind.toLowerCase()}` });
  });

  it("does not trip on the bare word 'aviso' or generic 'extrato'", () => {
    expect(detectNonFiscalKind("Aviso: mercadoria colocada à disposição")).toBeNull();
    expect(detectNonFiscalKind("extrato de tomate 500g")).toBeNull();
  });

  it("QR incomplete (no Q/R) or wrong NIF → INDETERMINADO", () => {
    expect(classifyFiscalStatus({ qr: { ...VALID_QR, hash4: undefined }, qrOrigin: "zxing" }).fiscalStatus).toBe("INDETERMINADO");
    expect(classifyFiscalStatus({ qr: { ...VALID_QR, issuerNif: "500842010" }, qrOrigin: "zxing" }).fiscalStatus).toBe("INDETERMINADO");
    expect(isValidAtQr({ ...VALID_QR, softwareCert: "abc" })).toBe(false);
  });

  it("an AI read-back of the QR never certifies the document", () => {
    const out = classifyFiscalStatus({ qr: VALID_QR, qrOrigin: "ai" });
    expect(out).toMatchObject({ fiscalStatus: "INDETERMINADO", reason: "qr_from_ai_readback_not_certified" });
  });

  it("foreign invoice: FISCAL only when VIES validated, else vies_pending", () => {
    const base = { supplierVatId: "ESB06612386", docNumber: "VFV26000793", docDate: "2026-02-04" };
    expect(classifyFiscalStatus({ ...base, viesValidated: true })).toMatchObject({ fiscalStatus: "FISCAL", reason: "foreign_vies_validated:ESB06612386" });
    expect(classifyFiscalStatus({ ...base })).toMatchObject({ fiscalStatus: "INDETERMINADO", reason: "vies_pending:ESB06612386" });
    expect(classifyFiscalStatus({ ...base, docDate: null, viesValidated: true }).fiscalStatus).toBe("INDETERMINADO");
  });

  it("EU VAT syntax: accepts EU prefixes, rejects non-EU and bad PT check digit", () => {
    expect(isSyntacticallyValidEuVat("ES B06612386")).toBe(true);
    expect(isSyntacticallyValidEuVat("FR04540090727")).toBe(true);
    expect(isSyntacticallyValidEuVat("PT500842019")).toBe(true);
    expect(isSyntacticallyValidEuVat("PT500842010")).toBe(false);
    expect(isSyntacticallyValidEuVat("GB123456789")).toBe(false);
    expect(isSyntacticallyValidEuVat("500842019")).toBe(false);
  });

  it("PT document without QR → INDETERMINADO (no_qr_at)", () => {
    expect(classifyFiscalStatus({ supplierNif: "500842019", docNumber: "FT 1/1", docDate: "2026-01-01" })).toMatchObject({
      fiscalStatus: "INDETERMINADO",
      reason: "no_qr_at",
    });
  });

  it("P0.2 — marks as NAO_APLICAVEL when own company NIF (515208566) is the issuer/vendor", () => {
    const out = classifyFiscalStatus({
      supplierNif: "515208566",
      tenantNif: "515208566",
      docNumber: "FT 2026/10",
      docDate: "2026-03-01",
    });
    expect(out.fiscalStatus).toBe("NAO_APLICAVEL");
    expect(out.reason).toBe("own_company_is_issuer:515208566");
  });

  it("P0.2 — marks customer order with own company NIF as NAO_APLICAVEL", () => {
    const out = classifyFiscalStatus({
      text: "Nota de Encomenda de Cliente nº 88",
      supplierNif: "515208566",
      tenantNif: "515208566",
      docNumber: "88",
      docDate: "2026-03-01",
    });
    expect(out.fiscalStatus).toBe("NAO_APLICAVEL");
    expect(out.documentType).toBe("ENCOMENDA");
  });

  it("P0.2 — keeps purchase circuit normal when own company is the buyer", () => {
    const out = classifyFiscalStatus({
      qr: VALID_QR,
      qrOrigin: "zxing",
      supplierNif: "500842019",
      customerNif: "515208566",
      tenantNif: "515208566",
    });
    expect(out.fiscalStatus).toBe("FISCAL");
  });

  it("classifies simplified invoice as FISCAL even if supplierNif matches tenant NIF", () => {
    const out = classifyFiscalStatus({
      text: "Fatura Simplificada FS A2605/3085 Restaurante Clipper",
      supplierNif: "515208566",
      tenantNif: "515208566",
      docNumber: "FS A2605/3085",
      docDate: "2026-03-01",
    });
    expect(out.fiscalStatus).toBe("FISCAL");
    expect(out.documentType).toBe("FATURA_SIMPLIFICADA");
    expect(out.reason).toBe("simplified_invoice_expense");
  });
});

describe("Fase 3 — normalizeDocNumber (fiscal key)", () => {
  it.each([
    ["FT 2026A92/6384", "2026A926384"],
    ["FT2026A92/6384", "2026A926384"],
    ["2026A92/6384", "2026A926384"],
    ["FR 1/8482", "18482"],
    ["FS 274271005/028318", "274271005028318"],
    ["FT_AAA26_05582", "AAA2605582"],
    ["FAC 0010322025/0000428", "00103220250000428"],
    ["VFV26000793", "VFV26000793"],
    ["fat FAT2026/396", "FAT2026396"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDocNumber(input)).toBe(expected);
  });

  it("returns null for empty / too short values", () => {
    expect(normalizeDocNumber("")).toBeNull();
    expect(normalizeDocNumber(null)).toBeNull();
    expect(normalizeDocNumber("FT")).toBeNull();
  });
});
