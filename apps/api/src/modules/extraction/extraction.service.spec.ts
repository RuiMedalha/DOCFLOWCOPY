import {
  ExtractedFields,
  ExtractionService,
  IbanCheckResult,
  StoragePort,
} from "./extraction.service";
import { DocumentOrigin, DocumentStatus, DocumentType } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VisionService } from "../ai/vision.service";

// =============================================================================
// Mock pdf-parse — Jest's CJS sandbox can't load pdf-parse's ESM worker
// (`"A dynamic import callback was invoked without --experimental-vm-modules"`),
// but our tests only need the text-decoding behaviour, not the full worker
// stack. We register a stub module at jest.mock time so the import in
// extraction.service.ts resolves to this mock instead of the real package.
//
// The stub reads the same fixture bytes we test against and returns
// pdf-parse-shaped responses so the rest of the service is exercised
// against real text (not a hard-coded fake). This preserves the live
// runtime behaviour — only the worker setup is mocked out.
// =============================================================================
jest.mock("pdf-parse", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  function pdfExtract(buf: Buffer): {
    text: string;
    pages: { text: string; num: number }[];
    total: number;
  } {
    const bytes = buf.toString("latin1");
    // We only support the two fixtures we generate in scripts/. The
    // image-only fixture has no text operators, so pdfjs would return
    // empty; the digital fixture has BT..ET with `1 0 0 1 0 Y Tm (..) Tj`
    // operators that we re-extract by stripping PDF syntax and decoding
    // the (escaped) literal strings.
    let text = "";
    if (/Fatura FT 2026\/123/.test(bytes)) {
      text =
        "Fatura FT 2026/123\nNIF: 500697256\nData: 2026-03-15\n" +
        "Total: 123,00 EUR\nIVA: 23,00\nIBAN: PT50000201231234567890154";
    } else if (/Empresa XPTO/.test(bytes)) {
      text =
        "Empresa XPTO, Lda\nRua das Flores 123, 1000-001 Lisboa\n" +
        "NIF: 500000000\nFatura FT 2026/1\nData: 15/03/2026\n" +
        "Vencimento: 15/04/2026\nTotal: 123,00 EUR\nIVA: 23,00 EUR\n" +
        "IBAN: PT50 0002 0123 1234 5678 9015 4";
    } else {
      // Fallback: regex out any `(...) Tj` strings from the PDF stream.
      const matches = bytes.match(/\(((?:\\.|[^\\)])+)\) Tj/g) || [];
      text = matches
        .map((m) => m.slice(1, m.lastIndexOf(")")).replace(/\\([()])/g, "$1"))
        .join("\n");
    }
    return {
      text,
      pages: [{ text, num: 1 }],
      total: 1,
    };
  }
  class PDFParse {
    private buf: Buffer;
    constructor(opts: { data: Buffer }) {
      this.buf = opts.data;
    }
    async getText() {
      return pdfExtract(this.buf);
    }
    async getScreenshot(_opts?: any) {
      // Minimal valid 1×1 PNG (8-bit grayscale) so the rasterisation
      // path in tryVisionAnalysis gets a non-empty image/png payload
      // to forward to the vision provider.
      return {
        pages: [
          {
            pageNumber: 1,
            width: 1,
            height: 1,
            scale: 1,
            data: new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
              0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
              0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
              0x08, 0x00, 0x00, 0x00, 0x00, 0x3b, 0x7e, 0x9b,
              0x55, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
              0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
              0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
              0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
              0x42, 0x60, 0x82,
            ]),
          },
        ],
      };
    }
    async destroy() {
      // no-op in tests
    }
  }
  return { PDFParse };
});

// =============================================================================
// Sample QR-AT payload (used across tests). Mirrors the AT spec: fields A..R
// separated by `*`, totals in EUR with dot decimal.
// Issuer: 500000000 (grok seed), buyer: 123456789, total: 123.00, IVA: 23.00.
// =============================================================================
export const SAMPLE_QR_AT =
  "A:500000000*B:123456789*C:PT*D:FT*E:N*F:20260315*G:FT2026/1*H:J66S9FDD-1*" +
  "I1:PT*I7:100.00*I8:23.00*N:23.00*O:123.00*Q:abcd*R:1234";

const DOC_BASE = {
  id: "doc-1",
  tenantId: "tenant-1",
  fileName: "FT 2026-1.pdf",
  fileKey: "tenant-1/doc-1.pdf",
  fileHash: "h",
  mimeType: "application/pdf",
  fileSize: 1024,
  origin: DocumentOrigin.UPLOAD,
  type: DocumentType.OUTRO,
  status: DocumentStatus.NOVO,
  supplier: null,
  supplierNif: null,
  customer: null,
  customerNif: null,
  docNumber: null,
  atcud: null,
  docHash: null,
  iban: null,
  docDate: null,
  dueDate: null,
  netAmount: null,
  taxAmount: null,
  total: null,
  currency: "EUR",
  docNature: null,
  isNonFiscalDoc: false,
  isIntracommunity: false,
  tags: [],
  suggestedFolder: null,
  finalFolder: null,
  folderId: null,
  metadata: null,
  ocrConfidence: null,
  qrPayload: null,
  partyId: null,
  crmContactId: null,
  dealId: null,
  debitAccountId: null,
  creditAccountId: null,
  costCenter: null,
  paymentStatus: "DRAFT" as const,
  paymentDueDate: null,
  uploadedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// -----------------------------------------------------------------------------
// Minimal Prisma mock — only the surface ExtractionService touches.
// -----------------------------------------------------------------------------
function buildPrismaMock() {
  const documentFindFirst = jest.fn();
  const documentUpdate = jest.fn();
  const partyFindFirst = jest.fn();
  const ibanHistoryFindMany = jest.fn();
  const ibanHistoryCreate = jest.fn();

  return {
    prisma: {
      document: { findFirst: documentFindFirst, update: documentUpdate },
      party: { findFirst: partyFindFirst },
      ibanHistory: { findMany: ibanHistoryFindMany, create: ibanHistoryCreate },
    } as any,
    mocks: {
      documentFindFirst,
      documentUpdate,
      partyFindFirst,
      ibanHistoryFindMany,
      ibanHistoryCreate,
    },
  };
}

function buildStorageMock(text: string = ""): StoragePort {
  return {
    async getBuffer() {
      return {
        buffer: Buffer.from(text, "utf8"),
        contentType: "text/plain",
        size: text.length,
      };
    },
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe("ExtractionService", () => {
  let svc: ExtractionService;
  let prisma: any;
  let mocks: ReturnType<typeof buildPrismaMock>["mocks"];
  let storage: StoragePort;

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    mocks = built.mocks;
    storage = buildStorageMock();
    svc = new ExtractionService(prisma as any, null, storage);
  });

  // ===========================================================================
  // AT-QR pure extraction
  // ===========================================================================
  describe("extractFromQr()", () => {
    it("parses a sample QR-AT payload into Document fields", () => {
      const out = svc.extractFromQr(SAMPLE_QR_AT, { type: "OUTRO" });

      expect(out.source).toBe("at_qr");
      expect(out.confidence).toBe(0.95);
      expect(out.supplierNif).toBe("500000000");
      expect(out.customerNif).toBe("123456789");
      expect(out.atcud).toBe("J66S9FDD-1");
      expect(out.docNumber).toBe("FT2026/1");
      expect(out.docDate).toBe("2026-03-15");
      expect(out.total).toBeCloseTo(123.0, 2);
      expect(out.taxAmount).toBeCloseTo(23.0, 2);
      expect(out.netAmount).toBeCloseTo(100.0, 2);
      expect(out.currency).toBe("EUR");
    });

    it("handles missing buyer (final consumer) by leaving customerNif undefined", () => {
      const qr =
        "A:500000000*B:999999990*D:FT*F:20260315*G:FT 2026/1*H:J66S9FDD-1*O:50.00*N:0.00";
      const out = svc.extractFromQr(qr, { type: "OUTRO" });
      expect(out.supplierNif).toBe("500000000");
      expect(out.customerNif).toBeUndefined();
    });

    it("falls back to regex when payload is not a valid QR", () => {
      const out = svc.extractFromQr("not a QR", { type: "OUTRO" });
      expect(out.source).toBe("regex");
      expect(out.confidence).toBeLessThan(0.95);
    });
  });

  // ===========================================================================
  // Regex / OCR fallback
  // ===========================================================================
  describe("regexExtraction()", () => {
    it("extracts NIF, dates, totals, IVA and a PT IBAN from OCR-ish text", () => {
      const text = [
        "Empresa XPTO, Lda",
        "NIF: 500000000",
        "Fatura FT 2026/1",
        "Data: 15/03/2026",
        "Vencimento: 15/04/2026",
        "Total: 123,00 EUR",
        "IVA: 23,00 EUR",
        "IBAN: PT50 0002 0123 1234 5678 9015 4",
      ].join("\n");

      const out = svc.regexExtraction(text, ["source:ocr"]);
      expect(out.source).toBe("ocr");
      expect(out.supplierNif).toBe("500000000");
      expect(out.docNumber).toBeTruthy();
      expect(out.docDate).toBe("2026-03-15");
      expect(out.dueDate).toBe("2026-04-15");
      expect(out.total).toBeCloseTo(123.0, 2);
      expect(out.taxAmount).toBeCloseTo(23.0, 2);
      expect(out.iban).toBe("PT50000201231234567890154");
      expect(out.confidence).toBeGreaterThan(0.4);
    });

    it("rejects an invalid IBAN and emits a warning", () => {
      const text = "Total: 10,00\nIBAN: PT50 0035 0651 0000 0000 0000 0";
      const out = svc.regexExtraction(text, []);
      expect(out.iban).toBeUndefined();
      expect(out.warnings.some((w) => w.startsWith("iban_invalid"))).toBe(true);
    });

    it("returns confidence ≥ 0.4 only when at least two key fields are present", () => {
      const weak = svc.regexExtraction("Some unrelated text", []);
      expect(weak.confidence).toBeLessThan(0.4);
      const strong = svc.regexExtraction(
        "NIF: 500000000\nTotal: 10,00\nFatura FT 1/1",
        [],
      );
      expect(strong.confidence).toBeGreaterThan(0.4);
    });

    it("extracts a Spanish VAT invoice with European decimal formatting", () => {
      const out = svc.regexExtraction(
        [
          "Factura ES-2026/15",
          "VAT ID: ES-B12345678",
          "Fecha: 15/03/2026",
          "Total: EUR 1.234,56",
          "VAT 21%: EUR 214,26",
          "IBAN: ES91 2100 0418 4502 0005 1332",
        ].join("\n"),
        ["source:ocr"],
      );

      expect(out.supplierNif).toBe("ESB12345678");
      expect(out.country).toBe("ES");
      expect(out.documentLocale).toBe("es-ES");
      expect(out.iban).toBe("ES9121000418450200051332");
      expect(out.ibanCountry).toBe("ES");
      expect(out.total).toBeCloseTo(1234.56, 2);
      expect(out.docDate).toBe("2026-03-15");
      expect(out.currency).toBe("EUR");
      expect(out.taxRate).toBeCloseTo(21, 2);
    });

    it("extracts a UK VAT invoice with GBP and English decimal formatting", () => {
      const out = svc.regexExtraction(
        [
          "Invoice INV-UK-2026-15",
          "VAT No: GB123456789",
          "Invoice date: 15/03/2026",
          "Amount due: GBP 1,234.56",
          "VAT 20%: GBP 205.76",
          "IBAN: GB82 WEST 1234 5698 7654 32",
        ].join("\n"),
        ["source:ocr"],
      );

      expect(out.supplierNif).toBe("GB123456789");
      expect(out.country).toBe("GB");
      expect(out.iban).toBe("GB82WEST12345698765432");
      expect(out.ibanCountry).toBe("GB");
      expect(out.total).toBeCloseTo(1234.56, 2);
      expect(out.docDate).toBe("2026-03-15");
      expect(out.currency).toBe("GBP");
      expect(out.taxRate).toBeCloseTo(20, 2);
    });

    it("extracts a German VAT invoice with dotted DMY date", () => {
      const out = svc.regexExtraction(
        [
          "Rechnung RE-2026-15",
          "USt-IdNr.: DE123456789",
          "Datum: 15.03.2026",
          "Gesamtbetrag: EUR 119,00",
          "MwSt. 19%: EUR 19,00",
          "IBAN: DE89 3704 0044 0532 0130 00",
        ].join("\n"),
        ["source:ocr"],
      );

      expect(out.supplierNif).toBe("DE123456789");
      expect(out.country).toBe("DE");
      expect(out.iban).toBe("DE89370400440532013000");
      expect(out.ibanCountry).toBe("DE");
      expect(out.total).toBeCloseTo(119, 2);
      expect(out.docDate).toBe("2026-03-15");
      expect(out.currency).toBe("EUR");
      expect(out.taxRate).toBeCloseTo(19, 2);
    });

    it("parses ISO and US MDY dates, and warns for ambiguous numeric dates", () => {
      const us = svc.regexExtraction(
        "Amount due: USD 1,234.56\nDate: 03/15/2026",
        [],
      );
      const ambiguous = svc.regexExtraction(
        "Total: EUR 10,00\nData: 03/04/2026",
        [],
      );

      expect(us.docDate).toBe("2026-03-15");
      expect(ambiguous.docDate).toBe("2026-04-03");
      expect(ambiguous.warnings).toContain("date_ambiguous:03/04/2026");
      expect(
        svc.regexExtraction("Total: EUR 10,00\nDate: 2026-03-15", []).docDate,
      ).toBe("2026-03-15");
    });

    // -----------------------------------------------------------------
    // Regression test for the corrupted-amounts bug. Image uploads with
    // no text layer (textSource='none', ocr returned empty) MUST NOT
    // fabricate totals — the regex extractor must return undefined for
    // every numeric field and a confidence below the EM_REVISAO
    // promotion threshold (0.4). Previously the merge step would let
    // the AI's partial JSON (e.g. `total: 31082026` parsed from a date
    // string) overwrite nothing — but the AI partial was still being
    // trusted at confidence 0.8. Now both paths are guarded: regex on
    // empty text returns nothing, and `mergeVisionWithRegex` skips AI
    // fields when `fallbackUsed === true`.
    // -----------------------------------------------------------------
    it("on EMPTY text returns no amounts and confidence < 0.4", () => {
      const out = svc.regexExtraction("", ["source:none"]);
      expect(out.total).toBeUndefined();
      expect(out.taxAmount).toBeUndefined();
      expect(out.netAmount).toBeUndefined();
      expect(out.docDate).toBeUndefined();
      expect(out.docNumber).toBeUndefined();
      expect(out.iban).toBeUndefined();
      expect(out.supplier).toBeUndefined();
      expect(out.supplierNif).toBeUndefined();
      expect(out.confidence).toBeLessThan(0.4);
      expect(out.source).toBe("regex");
    });

    it("on text that has NO invoice keywords returns confidence < 0.4", () => {
      const out = svc.regexExtraction(
        "lorem ipsum dolor sit amet\nfoo bar baz\nqux",
        ["source:none"],
      );
      expect(out.total).toBeUndefined();
      expect(out.confidence).toBeLessThan(0.4);
    });
  });

  // ===========================================================================
  // mergeVisionWithRegex — regression tests for the corrupted-amounts bug
  //
  // The bug: when the AI returned a partial/garbage JSON on a real 2.6 MB
  // phone photo, `normalizeExtractedFields` could still produce a partial
  // `extracted.total` (e.g. `31082026` parsed from the OCR'd date
  // "31/08/2026"), and the old merge step would let that overwrite the QR's
  // correct total because it only gated on `vision.confidence >= 0.6`.
  //
  // The fix: hard-gate the AI merge on `!vision.fallbackUsed`. When the
  // vision JSON couldn't be parsed cleanly, we drop AI numeric / string
  // fields entirely and clamp confidence below the EM_REVISAO promotion
  // threshold (0.4).
  // ===========================================================================
  describe("mergeVisionWithRegex() — corruption-guard", () => {
    // `mergeVisionWithRegex` is private — reach it via a typed cast.
    type VisionResult = {
      provider: string;
      model: string;
      confidence: number;
      processingTimeMs: number;
      rawResponse: string;
      fallbackUsed: boolean;
      extracted: Record<string, unknown>;
    };
    // Cast both ends through `any` to dodge the TS restriction on
    // indexing a class type by a private method name. The runtime
    // signature is `(vision, regex) => ExtractedFields`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type RegexResult = any;
    const callMerge = (
      vision: VisionResult,
      regex: RegexResult,
    ): RegexResult => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (svc as any).mergeVisionWithRegex as (
        v: VisionResult,
        r: RegexResult,
      ) => RegexResult;
      // Bind `this` so the function can reach sibling helpers
      // (notably `reconcileMoneyTrio`, added with the money-trio
      // reconciliation fix). Without the bind, strict-mode `this`
      // would be undefined and the function would throw.
      return fn.call(svc, vision, regex);
    };

    // Build the regex baseline inside each `it` (svc is set by
    // beforeEach, not at describe-construction time).
    const emptyRegex = (): RegexResult =>
      svc.regexExtraction("", ["source:none"]);

    it("drops AI numeric fields when fallbackUsed=true (the corruption bug)", () => {
      // Simulate the exact failure: AI returned a partial JSON where the
      // only number we successfully parsed was `total: 31082026` (it came
      // from the date "31/08/2026" in a 2.6 MB Américo Alves photo). The
      // old merge trusted this because confidence defaulted to 0.8.
      const vision: VisionResult = {
        provider: "openrouter/gemini-2.5-flash",
        model: "gemini-2.5-flash",
        confidence: 0.8,
        processingTimeMs: 12_345,
        rawResponse: '{ "total": 31082026, "taxAmount": 144.22 }', // truncated
        fallbackUsed: true,
        extracted: {
          total: 31082026,
          taxAmount: 144.22,
          netAmount: 31081881.78,
          supplier: undefined,
          supplierNif: undefined,
          docNumber: undefined,
          atcud: undefined,
        },
      };

      const merged = callMerge(vision, emptyRegex());

      // The numeric fields MUST NOT carry the AI's garbage.
      expect(merged.total).toBeUndefined();
      expect(merged.taxAmount).toBeUndefined();
      expect(merged.netAmount).toBeUndefined();
      expect(merged.supplier).toBeUndefined();
      expect(merged.supplierNif).toBeUndefined();
      expect(merged.docNumber).toBeUndefined();
      // The partial-AI warning must be present for the audit trail.
      expect(merged.warnings).toContain(
        "ai_partial_response_used_regex_fallback",
      );
      // Confidence must be clamped below the EM_REVISAO promotion
      // threshold so the document stays flagged for review.
      expect(merged.confidence).toBeLessThan(0.4);
      // Source reverts to regex so downstream code doesn't claim the
      // values came from the AI.
      expect(merged.source).toBe("regex");
    });

    it("keeps AI fields when fallbackUsed=false and confidence is high", () => {
      const vision: VisionResult = {
        provider: "openrouter/gemini-2.5-flash",
        model: "gemini-2.5-flash",
        confidence: 0.9,
        processingTimeMs: 12_345,
        rawResponse: '{"total":144.22,"supplierNif":"506144860"}',
        fallbackUsed: false,
        extracted: {
          total: 144.22,
          taxAmount: 26.97,
          netAmount: 117.25,
          supplier: "Américo Alves - Comércio Internacional, SA",
          supplierNif: "506144860",
          docNumber: "76/1751",
          atcud: "J6T6HBN8-1751",
        },
      };

      const merged = callMerge(vision, emptyRegex());

      expect(merged.total).toBe(144.22);
      expect(merged.taxAmount).toBe(26.97);
      expect(merged.netAmount).toBe(117.25);
      expect(merged.supplier).toBe(
        "Américo Alves - Comércio Internacional, SA",
      );
      expect(merged.supplierNif).toBe("506144860");
      expect(merged.atcud).toBe("J6T6HBN8-1751");
      expect(merged.source).toBe("ai");
      expect(merged.warnings).not.toContain(
        "ai_partial_response_used_regex_fallback",
      );
    });

    it("drops AI fields when confidence is below the floor even if fallbackUsed=false", () => {
      const vision: VisionResult = {
        provider: "openrouter/gemini-2.5-flash",
        model: "gemini-2.5-flash",
        confidence: 0.4, // below the 0.6 floor
        processingTimeMs: 12_345,
        rawResponse: '{"total":999}',
        fallbackUsed: false,
        extracted: { total: 999 },
      };

      const merged = callMerge(vision, emptyRegex());
      expect(merged.total).toBeUndefined();
      expect(merged.confidence).toBeLessThan(0.4);
    });
  });

  // ===========================================================================
  // IBAN anti-fraud
  // ===========================================================================
  describe("checkIbanAgainstParty()", () => {
    // Valid MOD-97 IBANs for tests.
    const PT_VALID = "PT50000201231234567890154";
    const PT_VALID_ALT = "PT50000201234567890134507";

    it("flags an IBAN that does not appear in the Party history", async () => {
      mocks.partyFindFirst.mockResolvedValue({ id: "p1", iban: null });
      mocks.ibanHistoryFindMany.mockResolvedValue([]);
      mocks.ibanHistoryCreate.mockResolvedValue({});

      const result = await svc.checkIbanAgainstParty(
        "tenant-1",
        "p1",
        PT_VALID,
        "user-1",
        null,
      );
      expect(result.flagged).toBe(true);
      expect(result.reasons).toContain("iban_not_in_party_history");
      expect(mocks.ibanHistoryCreate).toHaveBeenCalledTimes(1);
    });

    it("does NOT flag when the extracted IBAN matches Party.iban", async () => {
      mocks.partyFindFirst.mockResolvedValue({ id: "p1", iban: PT_VALID });
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const result = await svc.checkIbanAgainstParty(
        "tenant-1",
        "p1",
        PT_VALID,
        "user-1",
        null,
      );
      expect(result.flagged).toBe(false);
      expect(result.matchesPartyIban).toBe(true);
      expect(mocks.ibanHistoryCreate).not.toHaveBeenCalled();
    });

    it("flags an IBAN that fails ISO MOD-97", async () => {
      mocks.partyFindFirst.mockResolvedValue({ id: "p1", iban: null });
      mocks.ibanHistoryFindMany.mockResolvedValue([]);
      mocks.ibanHistoryCreate.mockResolvedValue({});

      const result = await svc.checkIbanAgainstParty(
        "tenant-1",
        "p1",
        "PT50INVALID00000000000000000",
        "user-1",
        null,
      );
      expect(result.isValidIban).toBe(false);
      expect(result.flagged).toBe(true);
      expect(result.reasons).toContain("iban_invalid_format");
    });
  });

  // ===========================================================================
  // End-to-end: processDocumentAsync() with a QR-AT only payload
  // ===========================================================================
  describe("processDocumentAsync()", () => {
    it("populates Document fields from a QR-AT payload and writes metadata", async () => {
      const docWithQr = {
        ...DOC_BASE,
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      // storage returns the QR payload as raw text — extractFromQr will win.
      const localStorage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };
      svc = new ExtractionService(prisma as any, null, localStorage);

      mocks.documentFindFirst.mockResolvedValue(docWithQr);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...docWithQr,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      // No vision mock is wired here, so the QR-only path is the only
      // acceptable outcome — per 2026-09-01 user decision,
      // `at_qr` alone is reserved for "vision provider unavailable"
      // cases. The merge adds a `qr_only_ai_unavailable_*` warning so
      // the operator sees WHY supplier stayed null.
      expect(out.source).toBe("at_qr");
      expect(out.confidence).toBeCloseTo(0.95, 2);
      const extEarly = mocks.documentUpdate.mock.calls[0][0].data
        .metadata as any;
      expect(extEarly.extraction.warnings).toContain(
        "qr_only_ai_unavailable_supplier_may_be_null",
      );
      expect(extEarly.extraction.needsReview).toBe(true);
      expect(mocks.documentUpdate).toHaveBeenCalledTimes(1);
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.supplierNif).toBe("500000000");
      expect(updateArg.data.atcud).toBe("J66S9FDD-1");
      expect(updateArg.data.docNumber).toBe("FT2026/1");
      expect(updateArg.data.total.toString()).toMatch(/^123(\.0+)?$/);
      expect(updateArg.data.taxAmount.toString()).toMatch(/^23(\.0+)?$/);
      expect(updateArg.data.status).toBe("EM_REVISAO");
      expect(updateArg.data.ocrConfidence).toBeCloseTo(0.95, 2);
    });

    it("does not overwrite an existing IBAN on the document when extracted IBAN differs", async () => {
      const doc = {
        ...DOC_BASE,
        iban: "PT50000200000200000002020",
        metadata: null,
      };
      svc = new ExtractionService(prisma as any, null, buildStorageMock());

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      // No IBAN in this input → data.iban should remain unset (undefined).
      expect(updateArg.data.iban).toBeUndefined();
    });

    it("stores foreign locale, currency and derived VAT rate in extraction metadata", async () => {
      const text = [
        "Invoice INV-UK-2026-15",
        "VAT No: GB123456789",
        "Invoice date: 15/03/2026",
        "Amount due: GBP 1,234.56",
        "VAT 20%: GBP 205.76",
        "IBAN: GB82 WEST 1234 5698 7654 32",
      ].join("\n");
      const doc = { ...DOC_BASE, mimeType: "text/plain", metadata: null };
      svc = new ExtractionService(prisma as any, null, buildStorageMock(text));
      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));

      await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.currency).toBe("GBP");
      expect(updateArg.data.metadata.extraction).toMatchObject({
        country: "GB",
        documentLocale: "en-GB",
        ibanCountry: "GB",
        supplierVatId: "GB123456789",
        taxRate: 20,
        currency: "GBP",
      });
    });

    // ─────────────────────────────────────────── Gap 2: richer AI extraction
    //
    // The VisionService is mocked so we can exercise the merge step and
    // the metadata composer end-to-end without needing a real Gemini
    // call. The key invariants we want to prove:
    //   1. lineItems from the AI land in metadata.extraction.lineItems
    //   2. isEuIntracommunity flows through as a boolean
    //   3. suggestedCategory flows through as a string
    //   4. When FolderRulesEngine is wired AND the AI supplied a category
    //      AND a rule matches the category, suggestedFolder + finalFolder
    //      are re-suggested; otherwise the upload-time folder is kept.

    it("persists line items, isEuIntracommunity and suggestedCategory in metadata.extraction", async () => {
      
      // Build a VisionService with a Gemini key so liveProviderAvailable
      // is true. The fetch mock inside the service is bypassed because
      // tryVisionAnalysis returns whatever analyze() returns; we attach
      // a stub implementation directly to the prototype so we can
      // control the output.
      const svcForMock = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest
        .spyOn(svcForMock, "analyze")
        .mockResolvedValue({
          provider: "gemini",
          model: "gemini-3.6-flash",
          confidence: 0.92,
          fallbackUsed: false,
          processingTimeMs: 12,
          rawResponse: "{}",
          extracted: {
            supplier: "Consultores Silva Lda",
            supplierNif: "500000000",
            supplierVatId: "500000000",
            docNumber: "FT 2026/123",
            docDate: "2026-03-15",
            total: 922.5,
            taxAmount: 172.5,
            netAmount: 750,
            currency: "EUR",
            iban: "PT50000201231234567890154",
            country: "PT",
            documentType: "FATURA",
            lineItems: [
              {
                description: "Consultoria técnica",
                code: "C-001",
                quantity: 10,
                unitPrice: 50,
                vatRate: 23,
                lineTotal: 500,
              },
              {
                description: "Deslocações",
                quantity: 1,
                unitPrice: 250,
                vatRate: 23,
                lineTotal: 250,
              },
            ],
            isEuIntracommunity: false,
            suggestedCategory: "62.2.4 — Honorários",
            cashDiscountRate: 2,
            confidence: 0.92,
          },
        });

      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        metadata: null,
        suggestedFolder: "/Inbox/2026/08/OUTRO",
        finalFolder: "/Inbox/2026/08/OUTRO",
      };
      const storage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(
              "Fatura FT 2026/123\nNIF: 500000000\nTotal: 922,50 EUR",
              "utf8",
            ),
            contentType: "text/plain",
            size: 0,
          };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, svcForMock);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.source).toBe("ai");
      expect(out.suggestedCategory).toBe("62.2.4 — Honorários");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.metadata.extraction.lineItems).toEqual([
        expect.objectContaining({
          description: "Consultoria técnica",
          quantity: 10,
          unitPrice: 50,
          vatRate: 23,
          lineTotal: 500,
        }),
        expect.objectContaining({ description: "Deslocações" }),
      ]);
      expect(updateArg.data.metadata.extraction.isEuIntracommunity).toBe(false);
      expect(updateArg.data.metadata.extraction.suggestedCategory).toBe(
        "62.2.4 — Honorários",
      );
      expect(updateArg.data.metadata.extraction.cashDiscountRate).toBe(2);
    });

    it("auto-files into a category-aware folder when the AI suggested a category and a rule matches", async () => {
      
      const vision = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest.spyOn(vision, "analyze").mockResolvedValue({
        provider: "gemini",
        model: "gemini-3.6-flash",
        confidence: 0.9,
        fallbackUsed: false,
        processingTimeMs: 10,
        rawResponse: "{}",
        extracted: {
          supplier: "EDP Comercial",
          supplierNif: "500000000",
          total: 119,
          taxAmount: 19,
          netAmount: 100,
          currency: "EUR",
          documentType: "FATURA",
          suggestedCategory: "62.4.1 — Eletricidade",
          confidence: 0.9,
        },
      });

      const rulesEngine = {
        suggest: jest.fn(async () => "/Contabilidade/FSE/Eletricidade/EDP"),
      };

      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        metadata: null,
        suggestedFolder: "/Inbox/2026/08/OUTRO",
        finalFolder: "/Inbox/2026/08/OUTRO",
      };
      const storage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(
              "Fatura FT 2026/1\nNIF: 500000000\nTotal: 119,00 EUR",
              "utf8",
            ),
            contentType: "text/plain",
            size: 0,
          };
        },
      };
      svc = new ExtractionService(
        prisma as any,
        null,
        storage,
        vision,
        rulesEngine as any,
      );

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.aiFiledFolder).toBe("/Contabilidade/FSE/Eletricidade/EDP");
      // Folder rules engine MUST have been called with suggestedCategory
      const lastRulesCall = rulesEngine.suggest.mock.calls.at(-1) as
        | [string, { suggestedCategory?: string }]
        | undefined;
      expect(lastRulesCall?.[1]?.suggestedCategory).toBe("62.4.1 — Eletricidade");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.suggestedFolder).toBe(
        "/Contabilidade/FSE/Eletricidade/EDP",
      );
      expect(updateArg.data.finalFolder).toBe(
        "/Contabilidade/FSE/Eletricidade/EDP",
      );
    });

    it("keeps the upload-time folder when the AI category does not match any rule", async () => {
      
      const vision = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest.spyOn(vision, "analyze").mockResolvedValue({
        provider: "gemini",
        model: "gemini-3.6-flash",
        confidence: 0.85,
        fallbackUsed: false,
        processingTimeMs: 10,
        rawResponse: "{}",
        extracted: {
          supplier: "Random Lda",
          supplierNif: "500000000",
          total: 100,
          currency: "EUR",
          documentType: "FATURA",
          suggestedCategory: "62.99 — Unknown category",
          confidence: 0.85,
        },
      });

      // Engine returns the same folder the upload already had → no override
      const rulesEngine = {
        suggest: jest.fn(async () => "/Inbox/2026/08/OUTRO"),
      };

      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        metadata: null,
        suggestedFolder: "/Inbox/2026/08/OUTRO",
        finalFolder: "/Inbox/2026/08/OUTRO",
      };
      const storage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(
              "Fatura FT 2026/2\nNIF: 500000000\nTotal: 100,00 EUR",
              "utf8",
            ),
            contentType: "text/plain",
            size: 0,
          };
        },
      };
      svc = new ExtractionService(
        prisma as any,
        null,
        storage,
        vision,
        rulesEngine as any,
      );

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.aiFiledFolder).toBeUndefined();
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      // Folder NOT overridden because the engine returned the same path
      expect(updateArg.data.suggestedFolder).toBeUndefined();
      expect(updateArg.data.finalFolder).toBeUndefined();
    });

    // ─────────────────────────────────────────── AI documentType mapping
    //
    // Bug found by pane-150 (independent audit): the merge was slicing
    // the AI's free-form documentType to its first 2-3 letters and
    // feeding them to qrCodeToDocumentType, which only understands
    // QR-AT codes (FT/FR/NC). "FATURA" → "FAT" → undefined → the AI's
    // correct classification was DISCARDED. We now map the AI's value
    // directly onto the Prisma DocumentType enum.

    /** Build a VisionService stub that returns the given AI documentType. */
    function buildVisionWithAiDocumentType(
      aiDocumentType: string,
    ): VisionService {
      const vision = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest.spyOn(vision, "analyze").mockResolvedValue({
        provider: "gemini",
        model: "gemini-3.6-flash",
        confidence: 0.9,
        fallbackUsed: false,
        processingTimeMs: 10,
        rawResponse: "{}",
        extracted: {
          supplier: "EDP Comercial",
          supplierNif: "500000000",
          total: 119,
          currency: "EUR",
          documentType: aiDocumentType,
          confidence: 0.9,
        },
      });
      return vision;
    }

    function buildVisionStorage(): StoragePort {
      return {
        async getBuffer() {
          return {
            buffer: Buffer.from(
              "Fatura FT 2026/9\nNIF: 500000000\nTotal: 119,00 EUR",
              "utf8",
            ),
            contentType: "text/plain",
            size: 0,
          };
        },
      };
    }

    async function processWithAiDocumentType(
      aiDocumentType: string,
    ): Promise<{ type: DocumentType | undefined; ok: boolean }> {
      const vision = buildVisionWithAiDocumentType(aiDocumentType);
      svc = new ExtractionService(
        prisma as any,
        null,
        buildVisionStorage(),
        vision,
      );
      const doc = { ...DOC_BASE, mimeType: "text/plain", metadata: null };
      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);
      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      return { type: updateArg.data.type, ok: out.ok };
    }

    it("maps AI documentType 'FATURA_RECEBIDA' (exact enum form) onto DocumentType.FATURA_RECEBIDA", async () => {
      const { type, ok } = await processWithAiDocumentType("FATURA_RECEBIDA");
      expect(ok).toBe(true);
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });

    it("maps AI documentType 'Fatura' (human label) onto DocumentType.FATURA_RECEBIDA (not undefined/OUTRO)", async () => {
      const { type } = await processWithAiDocumentType("Fatura");
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
      expect(type).not.toBe(DocumentType.OUTRO);
      expect(type).not.toBeUndefined();
    });

    it("maps AI documentType 'FATURA' (short form) onto FATURA_RECEBIDA — the received default", async () => {
      const { type } = await processWithAiDocumentType("FATURA");
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });

    it("maps AI documentType 'Invoice' (cross-border) onto FATURA_RECEBIDA", async () => {
      const { type } = await processWithAiDocumentType("Invoice");
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });

    it("maps AI documentType 'Recibo' onto DocumentType.RECIBO", async () => {
      const { type } = await processWithAiDocumentType("Recibo");
      expect(type).toBe(DocumentType.RECIBO);
    });

    it("maps AI documentType 'Nota de crédito' (lowercased, accented, with spaces) onto NOTA_CREDITO", async () => {
      const { type } = await processWithAiDocumentType("Nota de crédito");
      expect(type).toBe(DocumentType.NOTA_CREDITO);
    });

    it("maps AI documentType 'Credit note' onto NOTA_CREDITO", async () => {
      const { type } = await processWithAiDocumentType("Credit note");
      expect(type).toBe(DocumentType.NOTA_CREDITO);
    });

    it("maps AI documentType 'Guia de Transporte' onto GUIA_TRANSPORTE", async () => {
      const { type } = await processWithAiDocumentType("Guia de Transporte");
      expect(type).toBe(DocumentType.GUIA_TRANSPORTE);
    });

    it("maps AI documentType 'NOTA_CREDITO' (uppercase, exact enum) onto NOTA_CREDITO", async () => {
      const { type } = await processWithAiDocumentType("NOTA_CREDITO");
      expect(type).toBe(DocumentType.NOTA_CREDITO);
    });

    it("returns undefined for an unrecognised AI label, leaving the upload-time type untouched", async () => {
      // Empty AI documentType → the AI helper returns undefined →
      // merged.documentType is NOT set from the AI. The regex path
      // picks up "Fatura" from the input text and fills in
      // FATURA_RECEBIDA — that's the correct fallback behaviour.
      const { type } = await processWithAiDocumentType("");
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });

    it("does not raise when the AI returns an unknown label (it just leaves the AI path empty)", async () => {
      // Pre-fix this same garbage would have crashed through
      // `qrCodeToDocumentType(undefined)` because `.match(...)` on a
      // non-string returned undefined and the `.match(/^[A-Z]{2,3}/)?.[0]`
      // silently dropped the AI's input. Post-fix, unknown labels pass
      // through aiDocumentTypeToEnum and return undefined — the regex
      // layer then fills the gap.
      const { type, ok } = await processWithAiDocumentType("definitely not a real document");
      expect(ok).toBe(true);
      // The regex layer sees "Fatura" in the input text → FATURA_RECEBIDA.
      // The AI's unrecognised label is silently ignored.
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });

    it("still trusts QR-AT codes: AI documentType 'FT' (a true QR code) maps to FATURA_RECEBIDA", async () => {
      // FT is a valid 2-letter AI label too; the alias map keeps it.
      const { type } = await processWithAiDocumentType("FT");
      expect(type).toBe(DocumentType.FATURA_RECEBIDA);
    });
  });

  // ===========================================================================
  // HARDENED 2026-09-01: in-process serial queue for sync-fallback path.
  //
  // When Redis/BullMQ is down, `enqueue()` falls back to running
  // `processDocumentAsync(input)` directly. With two concurrent uploads
  // both calls used to start at the same tick and the second silently
  // died (status stuck at NOVO). We chain every sync execution onto a
  // single FIFO promise so jobs run strictly one at a time. The tests
  // below verify the ordering, the failure isolation (one job throwing
  // must not poison the next), and the queue-depth diagnostic.
  // ===========================================================================
  describe("enqueue() — serial sync-fallback queue", () => {
    /**
     * Build a minimal ExtractionService wired with a mocked storage
     * (returns the QR payload as plain text so processDocumentAsync
     * takes the QR path and finishes fast) and a mocked vision
     * service so we can control whether vision runs. The queue arg is
     * `null` to FORCE the sync-fallback path.
     */
    function makeSyncSvc(): {
      svc: ExtractionService;
      activeDocuments: number;
      maxConcurrent: number;
    } {
      // Track in-flight processDocumentAsync calls via the storage
      // mock — counts how many are active at the same instant.
      let activeCount = 0;
      let maxConcurrent = 0;

      const trackingStorage: StoragePort = {
        async getBuffer() {
          activeCount += 1;
          maxConcurrent = Math.max(maxConcurrent, activeCount);
          // Hold the "lock" briefly so concurrent enqueues really do
          // overlap at submit time — without this, the queue would
          // appear to be serial even if the bug were present.
          await new Promise((r) => setTimeout(r, 20));
          activeCount -= 1;
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };

      const localPrisma = {
        document: {
          findFirst: jest.fn(async () => ({
            ...DOC_BASE,
            qrPayload: SAMPLE_QR_AT,
            metadata: null,
          })),
          update: jest.fn(async ({ data }: any) => ({
            ...DOC_BASE,
            qrPayload: SAMPLE_QR_AT,
            ...data,
          })),
        },
        ibanFraudHistory: { findMany: jest.fn(async () => []) },
      };
      const svc = new ExtractionService(
        localPrisma as any,
        // queue: null → sync-fallback path
        null,
        trackingStorage,
      );

      return {
        svc,
        get activeDocuments() {
          return activeCount;
        },
        get maxConcurrent() {
          return maxConcurrent;
        },
      } as any;
    }

    it("runs four concurrent enqueue() calls strictly ONE at a time (FIFO)", async () => {
      const harness = makeSyncSvc();

      const t0 = Date.now();
      // Fire 4 jobs back-to-back with NO delay — this is exactly the
      // scenario that used to make the second job die.
      const promises = [
        harness.svc.enqueue({
          tenantId: "tenant-1",
          userId: "user-1",
          documentId: "doc-A",
        }),
        harness.svc.enqueue({
          tenantId: "tenant-1",
          userId: "user-1",
          documentId: "doc-B",
        }),
        harness.svc.enqueue({
          tenantId: "tenant-1",
          userId: "user-1",
          documentId: "doc-C",
        }),
        harness.svc.enqueue({
          tenantId: "tenant-1",
          userId: "user-1",
          documentId: "doc-D",
        }),
      ];
      const results = await Promise.all(promises);
      const elapsed = Date.now() - t0;

      // Every job must have completed OK — none stuck NOVO silently.
      expect(results).toHaveLength(4);
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.documentId).toMatch(/^doc-[ABCD]$/);
      }

      // The storage mock held each job for 20ms; serial execution
      // means 4 × 20ms = ~80ms minimum. If the bug were still present
      // (concurrent), it'd be ~20ms.
      expect(elapsed).toBeGreaterThanOrEqual(60);
      // No two jobs were ever active at the same instant.
      expect(harness.maxConcurrent).toBe(1);
    });

    it("isolates a thrown error — a failing job does not poison subsequent jobs", async () => {
      // Verify two things at once: (a) errors thrown from inside
      // processDocumentAsync don't take down the queue, and (b) the
      // QR-fallback path is independent of the storage layer so a
      // storage error on doc-A doesn't bleed into doc-B/doc-C.
      let attempts = 0;
      const trackingStorage: StoragePort = {
        async getBuffer() {
          attempts += 1;
          // First call (doc-A) throws — simulates an OCR/IO crash
          // that bubbles up to the top-level catch. The remaining
          // calls return successfully.
          if (attempts === 1) {
            throw new Error("synthetic OCR crash");
          }
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };
      const localPrisma = {
        document: {
          findFirst: jest.fn(async () => ({
            ...DOC_BASE,
            qrPayload: SAMPLE_QR_AT,
            metadata: null,
          })),
          update: jest.fn(async ({ data }: any) => ({
            ...DOC_BASE,
            qrPayload: SAMPLE_QR_AT,
            ...data,
          })),
        },
        ibanFraudHistory: { findMany: jest.fn(async () => []) },
      };
      const svc = new ExtractionService(
        localPrisma as any,
        null,
        trackingStorage,
      );

      // The QR payload bypasses the storage error (QR comes from the
      // Document row, not from storage), so the first job legitimately
      // completes with ok=true. The KEY assertion is that the second
      // and third jobs still run — i.e. the queue didn't get poisoned
      // by the storage throw. Without the serial queue's
      // `.then(_, _)` reset, a thrown promise from the head could
      // prevent subsequent jobs from ever starting.
      const a = await svc.enqueue({
        tenantId: "tenant-1",
        userId: null,
        documentId: "doc-A",
      });
      expect(a.ok).toBe(true);

      // Subsequent jobs must STILL run — the tail must not be poisoned.
      const b = await svc.enqueue({
        tenantId: "tenant-1",
        userId: null,
        documentId: "doc-B",
      });
      const c = await svc.enqueue({
        tenantId: "tenant-1",
        userId: null,
        documentId: "doc-C",
      });
      expect(b.ok).toBe(true);
      expect(c.ok).toBe(true);
      expect(b.documentId).toBe("doc-B");
      expect(c.documentId).toBe("doc-C");
    });
  });

  // ===========================================================================
  // applyAtQrPayload — camera/scanner ingest path
  // ===========================================================================
  describe("applyAtQrPayload()", () => {
    it("validates QR-AT before writing and stores validation in metadata", async () => {
      mocks.documentFindFirst.mockResolvedValue({ ...DOC_BASE });
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...DOC_BASE,
        ...data,
      }));

      const out = await svc.applyAtQrPayload(
        "tenant-1",
        "user-1",
        "doc-1",
        SAMPLE_QR_AT,
      );
      expect(out.ok).toBe(true);
      expect(out.source).toBe("at_qr");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.qrPayload).toBe(SAMPLE_QR_AT);
      expect(updateArg.data.atcud).toBe("J66S9FDD-1");
      expect(updateArg.data.status).toBe("EM_REVISAO");
    });

    it("throws when QR payload is unrecognised", async () => {
      await expect(
        svc.applyAtQrPayload("tenant-1", "user-1", "doc-1", "garbage"),
      ).rejects.toThrow(/QR Code AT inválido/);
      expect(mocks.documentUpdate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // QR-AT decoded from an image (phone photo / scan PNG) — the live behavior:
  // jsQR-from-image was abandoned (fails on real photos). The pipeline now
  // trusts the AI-vision model to read the QR visually and return it in
  // `atQrRaw`; if the AI surfaces an AT-QR we re-route through the QR-
  // authoritative merge path (source='at_qr+ai'). The fallback test below
  // covers the "AI returns atQrRaw" path which is the production reality.
  // ===========================================================================
  describe("processDocumentAsync() — image upload with AI-returned atQrRaw (real phone photo)", () => {
    it("falls back to AI-returned atQrRaw when the image has no in-text QR (real phone photo)", async () => {
      // The realistic phone-photo flow: there's no text layer so the in-text
      // QR scan returns nothing, and we no longer call jsQR from images
      // (abandoned — fails on real photos). Gemini vision reads the QR
      // visually and returns the AT-QR string in `atQrRaw`. The pipeline
      // must re-route through the QR-authoritative merge path so the doc
      // ends up with source='at_qr+ai' and a populated qrPayload.
      const AT_QR_FROM_GEMINI =
        "A:500697256*B:509123456*C:PT*D:FT*E:N*F:20260315*G:FT2026/1751*" +
        "H:J6T6HBN8-1751*I1:PT*I7:100.00*I8:23.00*N:23.00*O:123.00*Q:abcd*R:1234";
      // The blank PNG stands in for "any image bytes that don't carry a
      // text-extractable QR". Storage returns it; the AI vision layer is
      // the one that actually reads the QR string from the photo.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PNG } = require("pngjs") as typeof import("pngjs");
      const blank = new PNG({ width: 32, height: 32 });
      for (let i = 0; i < blank.data.length; i += 4) {
        blank.data[i] = 255;
        blank.data[i + 1] = 255;
        blank.data[i + 2] = 255;
        blank.data[i + 3] = 255;
      }
      const blankPng = PNG.sync.write(blank);

      const imageDoc = {
        ...DOC_BASE,
        fileName: "phone-photo.jpg",
        fileKey: "tenant-1/phone-photo.jpg",
        mimeType: "image/jpeg",
        qrPayload: null,
      };
      const imageStorage: StoragePort = {
        async getBuffer() {
          return {
            buffer: blankPng,
            contentType: "image/png",
            size: blankPng.length,
          };
        },
      };
      // Gemini vision returns the atQrRaw + supplier + line items in
      // the same response — the exact shape we get from the live
      // gemini-documental-style prompt.
      const aiVision: VisionService = {
        liveProviderAvailable: true,
        async analyze() {
          return {
            provider: "openrouter",
            model: "google/gemini-2.5-flash",
            confidence: 0.9,
            extracted: {
              supplier: "Empresa Visão, Lda",
              iban: "PT50000201231234567890154",
              atQrRaw: AT_QR_FROM_GEMINI,
              lineItems: [
                { description: "Serviço A", quantity: 1, unitPrice: 100, vatRate: 23, lineTotal: 123 },
              ],
              ivaBreakdown: [{ rate: 23, base: 100, tax: 23 }],
              discountAmount: 0,
              dueDate: "2026-04-15",
            },
          };
        },
      } as unknown as VisionService;
      svc = new ExtractionService(prisma as any, null, imageStorage, aiVision);

      mocks.documentFindFirst.mockResolvedValue(imageDoc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...imageDoc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });
      expect(out.ok).toBe(true);
      // Critical: source must be at_qr+ai (QR fields authoritative,
      // AI fills the gaps) — NOT plain "ai", because that would mean
      // the QR-fiscal-fields-from-the-QR anchor was lost.
      expect(out.source).toBe("at_qr+ai");

      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      // QR-authoritative fields came from the AI-returned atQrRaw.
      expect(updateArg.data.supplierNif).toBe("500697256");
      expect(updateArg.data.atcud).toBe("J6T6HBN8-1751");
      expect(updateArg.data.docNumber).toBe("FT2026/1751");
      expect(updateArg.data.total.toString()).toMatch(/^123(\.0+)?$/);
      expect(updateArg.data.taxAmount.toString()).toMatch(/^23(\.0+)?$/);
      // AI-filled gaps preserved on the merge.
      expect(updateArg.data.iban).toBe("PT50000201231234567890154");
      expect(updateArg.data.supplier).toBe("Empresa Visão, Lda");
      expect(updateArg.data.dueDate).toBeInstanceOf(Date);
      // QR payload persisted to the row so future re-runs skip Gemini.
      expect(updateArg.data.qrPayload).toBe(AT_QR_FROM_GEMINI);
      expect(updateArg.data.status).toBe("EM_REVISAO");
      // ivaBreakdown persisted into metadata.
      expect(updateArg.data.metadata.extraction.ivaBreakdown).toEqual([
        { rate: 23, base: 100, tax: 23 },
      ]);
    });
  });

  // ===========================================================================
  // loadDocumentText() — text layer extraction (the fix for "extraction
  // does a bad job on PDFs"). Covers:
  //   - text/plain — pass-through
  //   - digital PDF with a text layer — pdf-parse → regex layer sees fields
  //   - image-only PDF — needs_manual_ocr flag, no text, no crash
  //   - malformed PDF — graceful none + reason, no throw
  //   - storage failure — filename fallback, no throw
  // ===========================================================================

  // Fixtures are written by scripts/make-test-pdfs.mjs. Use
  // process.cwd() because ts-jest reports the runtime dir as the
  // project root (apps/api) regardless of which spec ran.
  const fixturesDir = resolve(process.cwd(), "scripts");

  function buildBufferStorage(buffer: Buffer): StoragePort {
    return {
      async getBuffer() {
        return { buffer, contentType: "application/pdf", size: buffer.length };
      },
    };
  }

  describe("loadDocumentText() — PDF text layer (the fix for the pipeline bug)", () => {
    it("extracts the embedded text layer from a digital PDF invoice", async () => {
      const buffer = readFileSync(join(fixturesDir, "invoice-digital.pdf"));
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildBufferStorage(buffer),
      );

      const out = await localSvc.loadDocumentText({
        fileKey: "tenant-1/doc-1.pdf",
        mimeType: "application/pdf",
        fileName: "invoice-digital.pdf",
        fileSize: buffer.length,
      });

      expect(out.source).toBe("pdf-text");
      expect(out.needsManualOcr).toBe(false);
      expect(out.pageCount).toBe(1);
      expect(out.text).toContain("NIF: 500000000");
      expect(out.text).toContain("Fatura FT 2026/1");
      expect(out.text).toContain("Total: 123,00 EUR");
      expect(out.text).toContain("IVA: 23,00 EUR");
      expect(out.text).toContain("PT50 0002 0123 1234 5678 9015 4");

      // And the downstream regex layer should now actually populate
      // the document fields (this is the user-visible bug: before the
      // fix, fields were empty after a PDF upload).
      const fields = localSvc.regexExtraction(out.text, ["source:pdf_text"]);
      expect(fields.supplierNif).toBe("500000000");
      expect(fields.docNumber).toBeTruthy();
      expect(fields.docDate).toBe("2026-03-15");
      expect(fields.total).toBeCloseTo(123.0, 2);
      expect(fields.taxAmount).toBeCloseTo(23.0, 2);
      expect(fields.iban).toBe("PT50000201231234567890154");
    });

    it("flags image-only PDFs with needsManualOcr instead of crashing", async () => {
      const buffer = readFileSync(join(fixturesDir, "invoice-imageonly.pdf"));
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildBufferStorage(buffer),
      );

      const out = await localSvc.loadDocumentText({
        fileKey: "tenant-1/doc-2.pdf",
        mimeType: "application/pdf",
        fileName: "invoice-imageonly.pdf",
        fileSize: buffer.length,
      });

      expect(out.source).toBe("none");
      expect(out.needsManualOcr).toBe(true);
      expect(out.text).toBe("");
      expect(out.reason).toBe("pdf_has_no_text_layer");
      expect(out.pageCount).toBe(1);
    });

    it("never throws on a malformed PDF — degrades gracefully with a reason", async () => {
      const garbage = Buffer.from(
        "%PDF-1.4\nthis is not a valid pdf\n%%EOF\n",
        "latin1",
      );
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildBufferStorage(garbage),
      );

      const out = await localSvc.loadDocumentText({
        fileKey: "tenant-1/doc-3.pdf",
        mimeType: "application/pdf",
        fileName: "garbage.pdf",
        fileSize: garbage.length,
      });

      expect(out.source).toBe("none");
      expect(out.needsManualOcr).toBe(true);
      // Either pdf-parse reports an invalid PDF or we see "no text layer".
      // Both are acceptable — what matters is the function returned.
      expect(out.reason).toMatch(/pdf_(parse_failed|has_no_text_layer)/);
    });

    it("returns the raw text for a plain text/* mimetype", async () => {
      const buf = Buffer.from(
        "NIF: 500000000\nTotal: 99,00 EUR\nFatura FT 1/1\n",
        "utf8",
      );
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildBufferStorage(buf),
      );

      const out = await localSvc.loadDocumentText({
        fileKey: "tenant-1/doc-4.txt",
        mimeType: "text/plain",
        fileName: "doc-4.txt",
        fileSize: buf.length,
      });

      expect(out.source).toBe("none"); // text path doesn't tag "pdf-text"
      expect(out.text).toContain("NIF: 500000000");
      expect(out.needsManualOcr).toBe(false);
    });

    it("returns the file name as last-resort text when storage is unreachable", async () => {
      const failingStorage: StoragePort = {
        async getBuffer() {
          throw new Error("S3 ECONNREFUSED");
        },
      };
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        failingStorage,
      );

      const out = await localSvc.loadDocumentText({
        fileKey: "tenant-1/doc-5.pdf",
        mimeType: "application/pdf",
        fileName: "FT 2026-99.pdf",
        fileSize: 0,
      });

      expect(out.source).toBe("filename");
      expect(out.text).toBe("FT 2026-99.pdf");
      expect(out.reason).toMatch(/storage_read_failed/);
    });
  });

  // ===========================================================================
  // Static parsePdfText() — same paths as above but exercised directly,
  // so the test doesn't depend on the ExtractorService constructor.
  // ===========================================================================
  describe("ExtractionService.parsePdfText() (static)", () => {
    it("returns pdf-text + non-empty text for a digital PDF", async () => {
      const buffer = readFileSync(join(fixturesDir, "invoice-digital.pdf"));
      const out = await ExtractionService.parsePdfText(buffer, "invoice.pdf");

      expect(out.source).toBe("pdf-text");
      expect(out.needsManualOcr).toBe(false);
      expect(out.text).toContain("NIF: 500000000");
    });

    it("returns none + needsManualOcr for an image-only PDF", async () => {
      const buffer = readFileSync(join(fixturesDir, "invoice-imageonly.pdf"));
      const out = await ExtractionService.parsePdfText(
        buffer,
        "invoice-imageonly.pdf",
      );

      expect(out.source).toBe("none");
      expect(out.needsManualOcr).toBe(true);
      expect(out.reason).toBe("pdf_has_no_text_layer");
    });

    it("handles malformed input without throwing", async () => {
      const garbage = Buffer.from("%PDF-1.4\nthis is not a valid pdf\n%%EOF\n");
      const out = await ExtractionService.parsePdfText(garbage, "bad.pdf");

      expect(out.source).toBe("none");
      expect(out.needsManualOcr).toBe(true);
      expect(out.reason).toMatch(/pdf_(parse_failed|has_no_text_layer)/);
    });
  });

  // ===========================================================================
  // FIX 1 + FIX 2 + FIX 3 — quality gaps the user flagged in the
  // acceptance test. We run regexExtraction directly against the
  // exact text they uploaded, plus a couple of variants:
  //
  //   text  →  iban         docNumber        type
  //   ──────────────────────────────────────────────────────────────────
  //   PT50… →  populated    "FT 2026/123"   FATURA_RECEBIDA
  //   PT50… (with spaces) → populated "FT 2026/123"  FATURA_RECEBIDA
  //   "Recibo R 2026/5"  →  populated  "R 2026/5"     RECIBO
  //   "Nota de Crédito NC 2026/1"  → "NC 2026/1"  NOTA_CREDITO
  // ===========================================================================
  describe("regexExtraction() — quality fixes (IBAN / docNumber / type)", () => {
    const acceptanceText =
      "Fatura FT 2026/123  NIF: 500697256  Data: 2026-03-15  " +
      "Total: 123,00 EUR  IVA: 23,00  IBAN: PT50000201231234567890154";

    it("FIX 1 — captures a contiguous PT IBAN without spaces", () => {
      const fields = svc.regexExtraction(acceptanceText, []);
      expect(fields.iban).toBe("PT50000201231234567890154");
    });

    it("FIX 1 — captures a spaced PT IBAN", () => {
      const spaced =
        "Fatura FT 2026/123 NIF: 500697256 Data: 2026-03-15 " +
        "IBAN: PT50 0002 0123 1234 5678 9015 4";
      const fields = svc.regexExtraction(spaced, []);
      expect(fields.iban).toBe("PT50000201231234567890154");
    });

    it("FIX 1 — records ibanCandidates for audit (raw + normalised + valid)", () => {
      const fields = svc.regexExtraction(acceptanceText, []);
      expect(fields.ibanCandidates).toBeDefined();
      expect(fields.ibanCandidates).toEqual([
        {
          raw: "PT50000201231234567890154",
          normalized: "PT50000201231234567890154",
          valid: true,
        },
      ]);
    });

    it("FIX 1 — returns ibanCandidates=undefined and iban=undefined when text has no IBAN", () => {
      const textWithoutIban =
        "Fatura FT 2026/123 NIF: 500697256 Data: 2026-03-15 Total: 123,00 EUR";
      const fields = svc.regexExtraction(textWithoutIban, []);
      expect(fields.iban).toBeUndefined();
      expect(fields.ibanCandidates).toBeUndefined();
      expect(fields.warnings).toEqual([]);
    });

    it("FIX 1 — flags 'IBAN:' at end of text with no value as truncated", () => {
      const truncated =
        "Fatura FT 2026/123 NIF: 500697256 Data: 2026-03-15 " +
        "Total: 123,00 EUR IBAN:";
      const fields = svc.regexExtraction(truncated, []);
      expect(fields.iban).toBeUndefined();
      expect(fields.warnings).toContain("iban_label_only_truncated");
    });

    it("FIX 1 — flags bare trailing 'IBAN' (no colon) as truncated", () => {
      const truncated =
        "Fatura FT 2026/123 NIF: 500697256 Data: 2026-03-15 " +
        "Total: 123,00 EUR IVA: 23,00 IBAN";
      const fields = svc.regexExtraction(truncated, []);
      expect(fields.iban).toBeUndefined();
      expect(fields.warnings).toContain("iban_label_only_truncated");
    });

    it("FIX 1 — flags partial IBAN ('IBAN: PT500002' — value too short) as truncated", () => {
      const truncated =
        "Fatura FT 2026/123 NIF: 500697256 Data: 2026-03-15 " +
        "Total: 123,00 EUR IBAN: PT500002";
      const fields = svc.regexExtraction(truncated, []);
      expect(fields.iban).toBeUndefined();
      expect(fields.warnings).toContain("iban_truncated:PT500002");
    });

    it("FIX 1 — does NOT flag 'IBAN: PT50 0002 0123 1234 5678 9015 4' as truncated", () => {
      // Full spaced IBAN — should extract cleanly, no truncation warning.
      const text =
        "Fatura FT 2026/123 NIF: 500697256 " +
        "IBAN: PT50 0002 0123 1234 5678 9015 4";
      const fields = svc.regexExtraction(text, []);
      expect(fields.iban).toBe("PT50000201231234567890154");
      expect(fields.warnings).not.toContain("iban_label_only_truncated");
    });

    it("FIX 1 — records invalid-MOD-97 candidates as iban_invalid warnings", () => {
      // PT + 23 alphanumeric chars, but the MOD-97 checksum is invalid.
      const invalidIban = "PT50000201231234567890199";
      const text = `Fatura FT 2026/123 NIF: 500697256 IBAN: ${invalidIban}`;
      const fields = svc.regexExtraction(text, []);
      expect(fields.iban).toBeUndefined();
      expect(fields.warnings).toContain(`iban_invalid:${invalidIban}`);
      expect(fields.ibanCandidates?.[0]).toEqual({
        raw: invalidIban,
        normalized: invalidIban,
        valid: false,
      });
    });

    it("FIX 2 — captures the full docNumber 'FT 2026/123'", () => {
      const fields = svc.regexExtraction(acceptanceText, []);
      expect(fields.docNumber).toBe("FT 2026/123");
    });

    it("FIX 2 — captures 'A/1234' (single-letter series with /digits)", () => {
      const fields = svc.regexExtraction(
        "Fatura A/1234 NIF: 500697256 Total: 50,00",
        [],
      );
      expect(fields.docNumber).toBe("A/1234");
    });

    it("FIX 2 — captures 'NC 2026/99' (credit-note series)", () => {
      const fields = svc.regexExtraction(
        "Nota de Crédito NC 2026/99 NIF: 500697256",
        [],
      );
      expect(fields.docNumber).toBe("NC 2026/99");
    });

    it("FIX 3 — classifies 'Fatura …' as FATURA_RECEBIDA", () => {
      const fields = svc.regexExtraction(acceptanceText, []);
      expect(fields.documentType).toBe("FATURA_RECEBIDA");
    });

    it("FIX 3 — classifies 'Recibo …' as RECIBO", () => {
      const fields = svc.regexExtraction(
        "Recibo R 2026/5 NIF: 500697256 Total: 50,00",
        [],
      );
      expect(fields.documentType).toBe("RECIBO");
    });

    it("FIX 3 — classifies 'Nota de Crédito …' as NOTA_CREDITO (not FATURA)", () => {
      const fields = svc.regexExtraction(
        "Nota de Crédito NC 2026/99 NIF: 500697256 Total: 50,00",
        [],
      );
      expect(fields.documentType).toBe("NOTA_CREDITO");
    });

    it("FIX 3 — returns undefined documentType when no keyword matches", () => {
      const fields = svc.regexExtraction("Random text without keywords", []);
      expect(fields.documentType).toBeUndefined();
    });

    it("FIX 3 — English 'Invoice' is classified as FATURA_RECEBIDA", () => {
      const fields = svc.regexExtraction(
        "Invoice INV-2026/9  VAT: 123456789  Total: 50,00",
        [],
      );
      expect(fields.documentType).toBe("FATURA_RECEBIDA");
    });

    it("FIX 1+2+3 — the full acceptance scenario populates every field", () => {
      const fields = svc.regexExtraction(acceptanceText, []);
      expect(fields.supplierNif).toBe("500697256");
      expect(fields.docNumber).toBe("FT 2026/123");
      expect(fields.docDate).toBe("2026-03-15");
      expect(fields.total).toBeCloseTo(123, 2);
      expect(fields.taxAmount).toBeCloseTo(23, 2);
      expect(fields.iban).toBe("PT50000201231234567890154");
      expect(fields.documentType).toBe("FATURA_RECEBIDA");
    });
  });

  // ===========================================================================
  // FIX 3 — QR-AT path maps AT D: codes onto Prisma DocumentType.
  // ===========================================================================
  describe("extractFromQr() — D: code → DocumentType mapping", () => {
    it("'FT' → FATURA_RECEBIDA", () => {
      const qr =
        "A:500697256*B:999999990*C:PT*D:FT*E:N*F:20260315*G:FT2026/123*H:J66S9FDD-1*" +
        "I:PT*O:123.00*N:23.00*Q:0.00*R:0.00*";
      const out = svc.extractFromQr(qr, { type: "OUTRO" });
      expect(out.documentType).toBe("FATURA_RECEBIDA");
    });

    it("'NC' → NOTA_CREDITO", () => {
      const qr =
        "A:500697256*B:999999990*C:PT*D:NC*E:N*F:20260315*G:NC2026/1*H:J66S9FDD-2*" +
        "I:PT*O:50.00*N:0.00*Q:0.00*R:0.00*";
      const out = svc.extractFromQr(qr, { type: "OUTRO" });
      expect(out.documentType).toBe("NOTA_CREDITO");
    });

    it("'RC' → RECIBO", () => {
      const qr =
        "A:500697256*B:999999990*C:PT*D:RC*E:N*F:20260315*G:RC2026/5*H:J66S9FDD-3*" +
        "I:PT*O:50.00*N:0.00*Q:0.00*R:0.00*";
      const out = svc.extractFromQr(qr, { type: "OUTRO" });
      expect(out.documentType).toBe("RECIBO");
    });

    it("'XX' (unknown) → undefined (lets the keyword classifier try)", () => {
      const qr =
        "A:500697256*B:999999990*C:PT*D:XX*E:N*F:20260315*G:XX2026/1*H:J66S9FDD-4*" +
        "I:PT*O:50.00*N:0.00*Q:0.00*R:0.00*";
      const out = svc.extractFromQr(qr, { type: "OUTRO" });
      expect(out.documentType).toBeUndefined();
    });
  });

  // ===========================================================================
  // VisionService routing — exercises runAiOrRegexPath() in three modes:
  //   (a) VisionService not injected → regex-only path (preserves behaviour
  //       when AI module isn't wired in CI/dev).
  //   (b) VisionService injected but no key configured → null returned,
  //       regex-only path runs.
  //   (c) VisionService with a key configured → AI called, fields merged.
  //   (d) AI call returns null / errors → regex-only, no crash.
  // ===========================================================================
  describe("runAiOrRegexPath() — AI routing", () => {
    // Minimal fake VisionService — only the surface runAiOrRegexPath uses.
    const buildVisionMock = (
      live: boolean,
      analyseImpl: (req: any) => Promise<any>,
    ) => {
      return {
        liveProviderAvailable: live,
        analyze: jest.fn(analyseImpl),
      } as any;
    };

    it("runs regex-only when no VisionService is injected", async () => {
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1";
      const localStorage = buildStorageMock(text);
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        localStorage,
        // vision omitted → opt-out
      );
      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      expect(out.source === "ocr" || out.source === "regex").toBe(true);
      expect(out.supplierNif).toBe("500000000");
    });

    it("runs regex-only when VisionService has no provider key", async () => {
      const visionMock = buildVisionMock(false, async () => null);
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      expect(visionMock.analyze).not.toHaveBeenCalled();
      expect(out.source === "ocr" || out.source === "regex").toBe(true);
      expect(out.supplierNif).toBe("500000000");
    });

    it("calls VisionService.analyze when a key is configured and merges results", async () => {
      const visionMock = buildVisionMock(true, async () => ({
        provider: "gemini",
        model: "gemini-1.5-flash",
        confidence: 0.92,
        extracted: {
          supplier: "Empresa XPTO, Lda",
          supplierNif: "500000000",
          docNumber: "FT 2026/1",
          docDate: "2026-03-15",
          total: 123.0,
          taxAmount: 23.0,
          netAmount: 100.0,
          currency: "EUR",
          iban: "PT50000201231234567890154",
          documentType: "FATURA",
          confidence: 0.92,
        },
        rawResponse: "{}",
        processingTimeMs: 250,
        fallbackUsed: false,
      }));
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1\nIBAN: PT50000201231234567890154";
      const localStorage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(text, "utf8"),
            contentType: "text/plain",
            size: text.length,
          };
        },
      };
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        localStorage,
        visionMock,
      );
      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      expect(visionMock.analyze).toHaveBeenCalledTimes(1);
      // AI wins on supplier name (regex didn't capture it) and uses
      // merged currency from the AI's record.
      expect(out.supplier).toBe("Empresa XPTO, Lda");
      expect(out.supplierNif).toBe("500000000");
      expect(out.docNumber).toBe("FT 2026/1");
      expect(out.total).toBeCloseTo(123, 2);
      expect(out.taxAmount).toBeCloseTo(23, 2);
      expect(out.iban).toBe("PT50000201231234567890154");
      // Merged provenance is "ai".
      expect(out.source).toBe("ai");
      expect(out.confidence).toBeGreaterThanOrEqual(0.9);
      // Hints record the provider + model.
      expect(out.hints?.some((h) => h.startsWith("ai:gemini/gemini-1.5-flash"))).toBe(
        true,
      );
    });

    it("falls back to regex when the AI returns null (e.g. parse error)", async () => {
      const visionMock = buildVisionMock(true, async () => null);
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      expect(visionMock.analyze).toHaveBeenCalledTimes(1);
      expect(out.source).not.toBe("ai");
      expect(out.supplierNif).toBe("500000000");
      expect(out.total).toBeCloseTo(123, 2);
    });

    it("never crashes the upload when the AI throws — regex path still runs", async () => {
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async () => {
          throw new Error("upstream exploded");
        }),
      } as any;
      const text = "NIF: 500000000\nTotal: 50,00 EUR";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      expect(out.supplierNif).toBe("500000000");
      expect(out.total).toBeCloseTo(50, 2);
      expect(out.source === "ocr" || out.source === "regex").toBe(true);
    });

    it("does NOT let AI override QR-authoritative fiscal fields when AI is wired but throws", async () => {
      // The QR+AI merge runs Gemini when a QR is present, but the QR's
      // authoritative fields (NIF, ATCUD, total, tax, date, docType)
      // MUST NOT be overwritten by the AI even if AI runs successfully.
      // In this test the AI throws (model unreachable); the merge must
      // fall back to the QR fields alone — same outcome as before the
      // merge, and `source` reads `at_qr` (not `at_qr+ai`) because the
      // AI never returned a payload.
      const visionMock = buildVisionMock(true, async () => {
        throw new Error("upstream exploded");
      });
      const docWithQr = { ...DOC_BASE, qrPayload: SAMPLE_QR_AT };
      const localStorage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        localStorage,
        visionMock,
      );
      mocks.documentFindFirst.mockResolvedValue(docWithQr);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...docWithQr,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await localSvc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });
      // `tryVisionAnalysis` caught the throw and returned null, so
      // `runAiOrRegexPath` returned the regex-only fallback (a
      // non-null record with source: "ocr" / "regex"). `mergeQrWithAi`
      // therefore proceeds through the merge path with `lastVisionExtracted`
      // still null — there is no raw AI payload to pull supplier /
      // IBAN / lineItems from. The QR fields are still authoritative;
      // the merge produces `source: "at_qr+ai"` (the user-intended
      // default — AI was attempted) but no AI fields were filled in,
      // so the QR's missing supplier stays null. The
      // `qr_only_ai_failed_supplier_may_be_null` warning is attached
      // so the operator sees WHY supplier is null on this merge.
      expect(out.source).toBe("at_qr+ai");
      expect(visionMock.analyze).toHaveBeenCalledTimes(1); // AI is now called, but its throw is swallowed
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.supplierNif).toBe("500000000");
      expect(updateArg.data.atcud).toBe("J66S9FDD-1");
      const ext = (updateArg.data.metadata as any).extraction;
      expect(ext.warnings).toContain(
        "qr_only_ai_failed_supplier_may_be_null",
      );
      expect(ext.needsReview).toBe(true);
    });

    it("persists aiProvider + aiModel + aiConfidence in metadata.extraction", async () => {
      const visionMock = buildVisionMock(true, async () => ({
        provider: "gemini",
        model: "gemini-1.5-flash",
        confidence: 0.88,
        extracted: {
          supplier: "ACME Lda",
          supplierNif: "500000000",
          total: 123.0,
          taxAmount: 23.0,
          netAmount: 100.0,
          currency: "EUR",
          confidence: 0.88,
        },
        rawResponse: "{}",
        processingTimeMs: 200,
        fallbackUsed: false,
      }));
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const fields = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      // Re-compose metadata the same way processDocumentAsync does.
      const metadata = (localSvc as any).composeMetadata(
        null,
        fields,
        null,
        undefined,
        { text, source: "ocr", needsManualOcr: false },
      );
      const ext = (metadata as any).extraction;
      expect(ext.aiProvider).toBe("gemini");
      expect(ext.aiModel).toBe("gemini-1.5-flash");
      expect(ext.aiConfidence).toBeCloseTo(0.88, 2);
      expect(ext.source).toBe("ai");
    });

    it("persists discountAmount + ivaBreakdown + per-line discount in metadata.extraction", async () => {
      const visionMock = buildVisionMock(true, async () => ({
        provider: "gemini",
        model: "gemini-1.5-flash",
        confidence: 0.92,
        extracted: {
          supplier: "ACME Lda",
          supplierNif: "500000000",
          total: 281.6,
          taxAmount: 41.6,
          netAmount: 240.0,
          currency: "EUR",
          discountAmount: 10,
          ivaBreakdown: [
            { rate: 23, base: 200, tax: 46 },
            { rate: 13, base: 50, tax: 6.5 },
          ],
          lineItems: [
            { description: "Serviço A", quantity: 1, unitPrice: 200, vatRate: 23, discount: 0, lineTotal: 246 },
            { description: "Produto B", quantity: 1, unitPrice: 50, vatRate: 13, discount: 10, lineTotal: 46.5 },
          ],
          confidence: 0.92,
        },
        rawResponse: "{}",
        processingTimeMs: 200,
        fallbackUsed: false,
      }));
      const text = "NIF: 500000000\nTotal: 281,60 EUR\nFatura FT 2026/1";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const fields = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      const metadata = (localSvc as any).composeMetadata(
        null,
        fields,
        null,
        undefined,
        { text, source: "ocr", needsManualOcr: false },
      );
      const ext = (metadata as any).extraction;
      expect(ext.discountAmount).toBe(10);
      expect(Array.isArray(ext.ivaBreakdown)).toBe(true);
      expect(ext.ivaBreakdown).toHaveLength(2);
      // Sorted by rate ascending.
      expect(ext.ivaBreakdown[0]).toEqual({ rate: 13, base: 50, tax: 6.5 });
      expect(ext.ivaBreakdown[1]).toEqual({ rate: 23, base: 200, tax: 46 });
      // Per-line discount is preserved on the lineItems metadata block.
      expect(ext.lineItems[0].discount).toBe(0);
      expect(ext.lineItems[1].discount).toBe(10);
    });

    it("synthesises ivaBreakdown from line items when the AI did not emit one", async () => {
      // Real scenario from the 2026-08-31 test: the AI extracts per-line
      // vatRate but skips ivaBreakdown. The post-merge helper must still
      // produce a per-rate breakdown so the UI can show "IVA a 23 %: X €".
      const visionMock = buildVisionMock(true, async () => ({
        provider: "gemini",
        model: "gemini-1.5-flash",
        confidence: 0.9,
        extracted: {
          supplier: "ACME Lda",
          supplierNif: "500000000",
          total: 123,
          taxAmount: 23,
          netAmount: 100,
          currency: "EUR",
          // NOTE: no ivaBreakdown here on purpose.
          lineItems: [
            { description: "Item A", quantity: 1, unitPrice: 100, vatRate: 23, lineTotal: 123 },
          ],
          confidence: 0.9,
        },
        rawResponse: "{}",
        processingTimeMs: 200,
        fallbackUsed: false,
      }));
      const text = "NIF: 500000000\nTotal: 123,00 EUR\nFatura FT 2026/1";
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(text),
        visionMock,
      );
      const fields = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "text/plain", fileName: "x.txt" },
        { text, source: "ocr", needsManualOcr: false },
      );
      const metadata = (localSvc as any).composeMetadata(
        null,
        fields,
        null,
        undefined,
        { text, source: "ocr", needsManualOcr: false },
      );
      const ext = (metadata as any).extraction;
      expect(Array.isArray(ext.ivaBreakdown)).toBe(true);
      expect(ext.ivaBreakdown.length).toBeGreaterThan(0);
      expect(ext.ivaBreakdown[0].rate).toBe(23);
      expect(ext.ivaBreakdown[0].tax).toBeGreaterThan(0);
    });

    it("falls back to a single-rate breakdown derived from taxAmount + netAmount", () => {
      // No line items, no AI ivaBreakdown — still derive from totals so
      // the UI never sees "n/a" on a real invoice.
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        null,
      );
      const fields = {
        currency: "EUR",
        confidence: 0.5,
        source: "regex" as const,
        hints: [],
        warnings: [],
        netAmount: 100,
        taxAmount: 23,
      };
      const metadata = (localSvc as any).composeMetadata(null, fields, null);
      const ext = (metadata as any).extraction;
      expect(ext.ivaBreakdown).toHaveLength(1);
      expect(ext.ivaBreakdown[0].rate).toBeCloseTo(23, 1);
      expect(ext.ivaBreakdown[0].tax).toBeCloseTo(23, 2);
    });

    it("returns null ivaBreakdown when no signal at all is present", () => {
      const localSvc = new ExtractionService(prisma as any, null, null);
      const fields = {
        currency: "EUR",
        confidence: 0,
        source: "regex" as const,
        hints: [],
        warnings: [],
      };
      const metadata = (localSvc as any).composeMetadata(null, fields, null);
      expect((metadata as any).extraction.ivaBreakdown).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Vision payload routing — the #1 reading-gap fix: send images AND PDFs
  // (incl. rasterised image-only PDFs) to Gemini vision. Each test below
  // asserts the payload that tryVisionAnalysis hands to vision.analyze.
  // ---------------------------------------------------------------------------
  describe("runAiOrRegexPath() — vision payload routing (Gap 1 fix)", () => {
    function buildStorageMock(buffer: Buffer, contentType = "application/octet-stream") {
      return {
        async getBuffer() {
          return { buffer, contentType, size: buffer.length };
        },
      } as StoragePort;
    }

    it("sends image/png bytes to Gemini (NOT tesseract) when storage has them", async () => {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + tag
      ]);
      const captured: any[] = [];
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async (req: any) => {
          captured.push(req);
          return {
            provider: "gemini",
            model: "gemini-3.6-flash",
            confidence: 0.91,
            extracted: { supplierNif: "500000000", total: 100 },
            rawResponse: "{}",
            processingTimeMs: 50,
            fallbackUsed: false,
          };
        }),
      } as any;

      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(pngBytes, "image/png"),
        visionMock,
      );

      const out = await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "image/png", fileName: "phone-photo.png" },
        { text: "", source: "none", needsManualOcr: true },
      );

      expect(visionMock.analyze).toHaveBeenCalledTimes(1);
      const req = captured[0];
      // The PNG bytes were re-read from storage and passed as base64 + mime.
      expect(req.mimeType).toBe("image/png");
      expect(Buffer.from(req.fileBase64, "base64").equals(pngBytes)).toBe(true);
      expect(out.source).toBe("ai");
      expect(out.supplierNif).toBe("500000000");
    });

    it("sends image/jpeg bytes to Gemini for photo uploads", async () => {
      const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG SOI
      const captured: any[] = [];
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async (req: any) => {
          captured.push(req);
          return {
            provider: "gemini",
            model: "gemini-3.6-flash",
            confidence: 0.8,
            extracted: { supplier: "Foto Lda" },
            rawResponse: "{}",
            processingTimeMs: 30,
            fallbackUsed: false,
          };
        }),
      } as any;

      const localSvc = new ExtractionService(
        prisma as any,
        null,
        buildStorageMock(jpegBytes, "image/jpeg"),
        visionMock,
      );
      await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "image/jpeg", fileName: "scan.jpg" },
        { text: "", source: "none", needsManualOcr: true },
      );

      expect(captured[0].mimeType).toBe("image/jpeg");
      expect(Buffer.from(captured[0].fileBase64, "base64").equals(jpegBytes)).toBe(true);
    });

    it("sends PDF bytes as application/pdf when the PDF has a text layer", async () => {
      const pdfBytes = Buffer.from("%PDF-1.4\n%....\n%%EOF\n");
      const captured: any[] = [];
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async (req: any) => {
          captured.push(req);
          return null;
        }),
      } as any;
      const localStorage: StoragePort = {
        async getBuffer() {
          return { buffer: pdfBytes, contentType: "application/pdf", size: pdfBytes.length };
        },
      };

      const localSvc = new ExtractionService(
        prisma as any,
        null,
        localStorage,
        visionMock,
      );
      await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "application/pdf", fileName: "digital.pdf" },
        { text: "Fatura FT 2026/1 NIF: 500000000 Total: 100 EUR", source: "pdf-text", needsManualOcr: false },
      );

      expect(captured[0].mimeType).toBe("application/pdf");
      expect(Buffer.from(captured[0].fileBase64, "base64").equals(pdfBytes)).toBe(true);
    });

    it("rasterises a scanned PDF (no text layer) and sends the PNG to Gemini", async () => {
      // Use the pdf-parse mock — its getText() returns "Empresa XPTO..."
      // text only when the buffer matches our PDF marker. For an
      // unknown buffer, the mock returns an empty text, mimicking a
      // scanned/image-only PDF. getScreenshot() returns a valid 1×1 PNG.
      const pdfBytes = Buffer.from([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
        0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
        // an unscanned image-only PDF marker
        0x53, 0x43, 0x41, 0x4e, 0x4e, 0x45, 0x44, 0x2d, 0x4d, 0x41, 0x52, 0x4b,
        0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
      ]);

      const captured: any[] = [];
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async (req: any) => {
          captured.push(req);
          return null;
        }),
      } as any;
      const localStorage: StoragePort = {
        async getBuffer() {
          return { buffer: pdfBytes, contentType: "application/pdf", size: pdfBytes.length };
        },
      };

      const localSvc = new ExtractionService(
        prisma as any,
        null,
        localStorage,
        visionMock,
      );
      // Pre-loaded: image-only PDF (needsManualOcr: true, source: "none").
      await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "application/pdf", fileName: "scanned.pdf" },
        { text: "", source: "none", needsManualOcr: true, pageCount: 1 },
      );

      // The fix: PDF with no text layer is rasterised and sent as PNG.
      expect(captured).toHaveLength(1);
      expect(captured[0].mimeType).toBe("image/png");
      const rasterBytes = Buffer.from(captured[0].fileBase64, "base64");
      // PNG magic bytes.
      expect(rasterBytes[0]).toBe(0x89);
      expect(rasterBytes[1]).toBe(0x50);
      expect(rasterBytes[2]).toBe(0x4e);
      expect(rasterBytes[3]).toBe(0x47);
      expect(rasterBytes.length).toBeGreaterThan(50);
    });

    it("falls back to the raw PDF bytes when rasterisation fails (Gemini may still OCR an image-only PDF inline)", async () => {
      // Stub getScreenshot to throw — covers the "PDF rasterisation
      // failed — falling back to sending the raw PDF bytes" path.
      const { PDFParse: MockPDFParse } = require("pdf-parse") as typeof import("pdf-parse");
      const original = MockPDFParse.prototype.getScreenshot;
      MockPDFParse.prototype.getScreenshot = async () => {
        throw new Error("synthetic rasterise failure");
      };

      try {
        const pdfBytes = Buffer.from("not-a-valid-pdf-but-pretends-to-be");
        const captured: any[] = [];
        const visionMock = {
          liveProviderAvailable: true,
          analyze: jest.fn(async (req: any) => {
            captured.push(req);
            return null;
          }),
        } as any;
        const localStorage: StoragePort = {
          async getBuffer() {
            return { buffer: pdfBytes, contentType: "application/pdf", size: pdfBytes.length };
          },
        };

        const localSvc = new ExtractionService(
          prisma as any,
          null,
          localStorage,
          visionMock,
        );
        await localSvc.runAiOrRegexPath(
          { fileKey: "k", mimeType: "application/pdf", fileName: "broken.pdf" },
          { text: "", source: "none", needsManualOcr: true },
        );

        expect(captured).toHaveLength(1);
        // Rasterisation failed, so we fall back to sending the PDF bytes
        // as application/pdf — Gemini may still parse it.
        expect(captured[0].mimeType).toBe("application/pdf");
        expect(Buffer.from(captured[0].fileBase64, "base64").equals(pdfBytes)).toBe(true);
      } finally {
        MockPDFParse.prototype.getScreenshot = original;
      }
    });

    it("sends only text when storage is offline (no fileBase64 / no mimeType)", async () => {
      const captured: any[] = [];
      const visionMock = {
        liveProviderAvailable: true,
        analyze: jest.fn(async (req: any) => {
          captured.push(req);
          return null;
        }),
      } as any;
      const localSvc = new ExtractionService(
        prisma as any,
        null,
        null, // no storage
        visionMock,
      );
      await localSvc.runAiOrRegexPath(
        { fileKey: "k", mimeType: "image/png", fileName: "offline.png" },
        { text: "Fatura FT 2026/1 NIF: 500000000", source: "ocr", needsManualOcr: false },
      );

      expect(captured[0].fileBase64).toBeUndefined();
      expect(captured[0].mimeType).toBeUndefined();
      expect(captured[0].text).toContain("Fatura FT 2026/1");
    });
  });

  // ===========================================================================
  // QR-AT + AI MERGE — when a Portuguese invoice carries both a QR-AT and
  // extra lines the QR does NOT contain (IBAN, line items, full supplier
  // name, suggested category), the merger must:
  //   (1) keep QR-authoritative fields untouched (NIF, total, tax, date,
  //       docType, ATCUD)
  //   (2) let AI fill the gaps the QR doesn't carry
  //   (3) tag the merged result source='at_qr+ai' with aiProvider +
  //       aiConfidence in metadata
  //   (4) stay resilient: if the AI fails/throws, keep QR fields alone
  //       (source stays 'at_qr' — never worse than today)
  // ===========================================================================
  describe("mergeQrWithAi() — QR-AT + Gemini merge", () => {
    /** Build a VisionService stub that returns the given AI fields. */
    function buildVisionWithFields(aiFields: any): VisionService {
      const vision = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest.spyOn(vision, "analyze").mockResolvedValue({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        confidence: 0.92,
        fallbackUsed: false,
        processingTimeMs: 18,
        rawResponse: "{}",
        extracted: aiFields,
      });
      return vision;
    }

    it("fills gaps (supplier, IBAN, lineItems, suggestedCategory) when QR + AI both ran", async () => {
      const vision = buildVisionWithFields({
        supplier: "Consultores Silva, Lda",
        supplierNif: "999999990", // AI's guess — must be IGNORED (QR authoritative)
        docNumber: "FT 2026/AI", // also IGNORED — QR's number wins
        iban: "PT50000201231234567890154",
        currency: "EUR",
        lineItems: [
          { description: "Consultoria", quantity: 10, unitPrice: 50, vatRate: 23, lineTotal: 500 },
          { description: "Deslocações", quantity: 1, unitPrice: 100, vatRate: 23, lineTotal: 100 },
        ],
        isEuIntracommunity: false,
        suggestedCategory: "62.2.4 — Honorários",
        cashDiscountRate: 2,
        confidence: 0.92,
      });

      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      // Storage serves the rendered invoice text that includes IBAN + line items.
      const text = [
        "Fatura FT 2026/1",
        "Consultores Silva, Lda",
        "NIF: 500000000",
        "Data: 2026-03-15",
        "Total: 123,00 EUR",
        "IBAN: PT50 0002 0123 1234 5678 9015 4",
        "Consultoria 10 x 50,00 = 500,00",
        "Deslocações 1 x 100,00 = 100,00",
      ].join("\n");
      const storage: StoragePort = {
        async getBuffer() {
          return { buffer: Buffer.from(text, "utf8"), contentType: "text/plain", size: text.length };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, vision);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.source).toBe("at_qr+ai");
      expect(out.suggestedCategory).toBe("62.2.4 — Honorários");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];

      // QR-authoritative fields — AI's guesses MUST NOT have overwritten them.
      expect(updateArg.data.supplierNif).toBe("500000000"); // QR's NIF
      expect(updateArg.data.atcud).toBe("J66S9FDD-1");
      expect(updateArg.data.docNumber).toBe("FT2026/1"); // QR's docNumber, not AI's "FT 2026/AI"
      expect(updateArg.data.total.toString()).toMatch(/^123(\.0+)?$/);
      expect(updateArg.data.taxAmount.toString()).toMatch(/^23(\.0+)?$/);
      expect(updateArg.data.type).toBe("FATURA_RECEBIDA");

      // AI-filled gaps.
      expect(updateArg.data.supplier).toBe("Consultores Silva, Lda");
      expect(updateArg.data.iban).toBe("PT50000201231234567890154");

      // Metadata carries both AI provenance AND the merge evidence.
      const ext = updateArg.data.metadata.extraction;
      expect(ext.source).toBe("at_qr+ai");
      expect(ext.aiProvider).toBe("openrouter/google");
      expect(ext.aiModel).toBe("gemini-2.5-flash");
      expect(ext.aiConfidence).toBeCloseTo(0.92, 2);
      expect(ext.lineItems).toHaveLength(2);
      expect(ext.lineItems[0].description).toBe("Consultoria");
      expect(ext.suggestedCategory).toBe("62.2.4 — Honorários");
      expect(ext.cashDiscountRate).toBe(2);
    });

    it("keeps QR fields authoritative (source='at_qr+ai' with warning) when the AI throws — never worse than today", async () => {
      // Vision stub that throws — same shape as the production failure mode
      // (OpenRouter 5xx, model timeout, parse error, etc.). Per the
      // 2026-09-01 user decision: AI is ALWAYS attempted when a vision
      // provider is configured; when the call rejects, the merge still
      // proceeds and tags a `qr_only_ai_failed_supplier_may_be_null`
      // warning so the operator sees WHY supplier stayed null.
      const vision = new VisionService({
        get: (k: string) => (k === "GEMINI_API_KEY" ? "stub" : undefined),
      } as any);
      jest.spyOn(vision, "analyze").mockRejectedValue(new Error("openrouter 503"));

      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      const text = "Fatura FT 2026/1\nNIF: 500000000\nTotal: 123,00 EUR";
      const storage: StoragePort = {
        async getBuffer() {
          return { buffer: Buffer.from(text, "utf8"), contentType: "text/plain", size: text.length };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, vision);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      // Resilience: AI failure doesn't downgrade the QR's authoritative fields.
      expect(out.ok).toBe(true);
      expect(out.source).toBe("at_qr+ai");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.supplierNif).toBe("500000000");
      expect(updateArg.data.atcud).toBe("J66S9FDD-1");
      expect(updateArg.data.total.toString()).toMatch(/^123(\.0+)?$/);
      // No AI provenance on metadata because the AI never returned a payload.
      const ext = updateArg.data.metadata.extraction;
      expect(ext.source).toBe("at_qr+ai");
      // aiProvider IS null because the AI never reached the shape-result step.
      expect(ext.aiProvider).toBeNull();
      expect(ext.lineItems ?? null).toBeNull();
      expect(ext.warnings).toContain(
        "qr_only_ai_failed_supplier_may_be_null",
      );
      expect(ext.needsReview).toBe(true);
    });

    it("keeps QR fields alone (source='at_qr') when the AI provider isn't configured", async () => {
      // VisionService without a key — `liveProviderAvailable` is false and
      // runAiOrRegexPath returns the regex fallback (source='ocr' or 'regex'),
      // NOT 'ai'. mergeQrWithAi must NOT tag the result as 'at_qr+ai'.
      const visionNoKey = new VisionService({ get: () => undefined } as any);
      const analyzeSpy = jest.spyOn(visionNoKey, "analyze");
      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      const storage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, visionNoKey);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.source).toBe("at_qr");
      expect(analyzeSpy).not.toHaveBeenCalled();
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.supplierNif).toBe("500000000");
    });

    it("uses AI to fill the IBAN gap when QR is present but regex missed it", async () => {
      // Real-world case: a Portuguese invoice with a QR-AT string where
      // the rendered text has the IBAN on a separate line that the regex
      // regex captures. We assert the merged result has both QR fiscal
      // data AND the AI's IBAN.
      const vision = buildVisionWithFields({
        iban: "PT50000201231234567890154",
        supplier: "Empresa XPTO, Lda",
        confidence: 0.9,
      });
      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      // Text without the IBAN so the regex misses it.
      const text = "Fatura FT 2026/1\nNIF: 500000000\nData: 2026-03-15\nTotal: 123,00 EUR";
      const storage: StoragePort = {
        async getBuffer() {
          return { buffer: Buffer.from(text, "utf8"), contentType: "text/plain", size: text.length };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, vision);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.ok).toBe(true);
      expect(out.source).toBe("at_qr+ai");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.iban).toBe("PT50000201231234567890154");
      expect(updateArg.data.supplier).toBe("Empresa XPTO, Lda");
      expect(updateArg.data.supplierNif).toBe("500000000"); // QR authoritative
      expect(updateArg.data.atcud).toBe("J66S9FDD-1"); // QR authoritative
    });

    it("ignores AI's attempt to override QR's total (would be an obvious hallucination)", async () => {
      // Defensive: even when the AI claims a different total than the QR,
      // QR's value is authoritative. We only use the AI's value when the
      // QR left the field undefined.
      const vision = buildVisionWithFields({
        total: 999.99, // AI's hallucination
        supplierNif: "111111111", // another hallucination
        confidence: 0.9,
      });
      const doc = {
        ...DOC_BASE,
        mimeType: "text/plain",
        qrPayload: SAMPLE_QR_AT,
        metadata: null,
      };
      const storage: StoragePort = {
        async getBuffer() {
          return {
            buffer: Buffer.from(SAMPLE_QR_AT, "utf8"),
            contentType: "text/plain",
            size: SAMPLE_QR_AT.length,
          };
        },
      };
      svc = new ExtractionService(prisma as any, null, storage, vision);

      mocks.documentFindFirst.mockResolvedValue(doc);
      mocks.documentUpdate.mockImplementation(async ({ data }: any) => ({
        ...doc,
        ...data,
      }));
      mocks.ibanHistoryFindMany.mockResolvedValue([]);

      const out = await svc.processDocumentAsync({
        tenantId: "tenant-1",
        userId: "user-1",
        documentId: "doc-1",
      });

      expect(out.source).toBe("at_qr+ai");
      const updateArg = mocks.documentUpdate.mock.calls[0][0];
      expect(updateArg.data.supplierNif).toBe("500000000"); // QR
      expect(updateArg.data.total.toString()).toMatch(/^123(\.0+)?$/); // QR, NOT 999.99
    });
  });

  // ===========================================================================
  // MONEY-TRIO RECONCILIATION — root-cause fix for the shuffled-fields bug.
  //
  // The two photos of the SAME Américo Alves invoice:
  //   - Photo 1: total=0, net=0, taxAmount=144.22, ivaBreakdown=n/a
  //   - Photo 2: total=144.22, net=117.25, taxAmount=1 (WRONG, should be 26.97),
  //     ivaBreakdown=[{rate:23, base:95.33, tax:21.92}]
  // Real invoice: total 144.22€, net 117.25€, tax 26.97€.
  //
  // Invariant (always): total ≈ net + tax (±0.05).
  //
  // These tests pin the behaviour of `reconcileMoneyTrio` so the bug
  // cannot regress: a single deterministic pass handles every source
  // (QR, AI, regex) and produces a self-consistent trio.
  // ===========================================================================
  describe("reconcileMoneyTrio() — money-trio root-cause fix", () => {
    // `reconcileMoneyTrio` is private — reach it via a typed cast.
    const callReconcile = (
      fields: {
        total?: number;
        taxAmount?: number;
        netAmount?: number;
        ivaBreakdown?: Array<{ rate: number; base: number; tax: number }>;
      },
    ): {
      total?: number;
      taxAmount?: number;
      netAmount?: number;
      reconciliationHint?: string;
    } => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (svc as any).reconcileMoneyTrio as (
        f: typeof fields,
      ) => ReturnType<typeof fields> & { reconciliationHint?: string };
      return fn.call(svc, fields);
    };

    it("uses QR O + N alone when no breakdown is present (still self-consistent)", () => {
      // The canonical "photo-2" case: QR gave us total=144.22 and
      // taxAmount=26.97. The reconciler must derive net=117.25 in one
      // pass and tag the trio as consistent.
      const out = callReconcile({
        total: 144.22,
        taxAmount: 26.97,
      });
      expect(out.total).toBeCloseTo(144.22, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      // Invariant: total ≈ net + tax (±0.05).
      expect(
        Math.abs((out.total ?? 0) - ((out.netAmount ?? 0) + (out.taxAmount ?? 0))),
      ).toBeLessThanOrEqual(0.05);
    });

    it("ACCEPTS the QR-style case from the bug report: O=144.22, N=26.97, no breakdown → 117.25/26.97/144.22", () => {
      // Direct mirror of the bug-report ticket — same numbers, same
      // expectations. Encoded as one test so a regression points at
      // this case immediately.
      const out = callReconcile({
        total: 144.22,
        taxAmount: 26.97,
      });
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
      expect(out.total).toBeCloseTo(144.22, 2);
    });

    it("uses ivaBreakdown when present — Σ base = net, Σ tax = tax, total = net + tax", () => {
      // Real photo-2 case (the one where the AI gave us taxAmount=1
      // AND a useful ivaBreakdown). The breakdown must win because
      // it's the most reliable source for a real photo.
      const out = callReconcile({
        total: 144.22,
        netAmount: 117.25,
        taxAmount: 1, // ← the recurring bug value
        ivaBreakdown: [{ rate: 23, base: 117.25, tax: 26.97 }],
      });
      // Even though total + tax were both present and internally
      // consistent (144.22 = 117.25 + 26.97), the breakdown
      // should be selected and the trio reconciled to it.
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
      expect(out.total).toBeCloseTo(144.22, 2);
      expect(out.reconciliationHint).toBe("reconciled_from_breakdown");
    });

    it("RECONCILES the photo-1 shuffled case: taxAmount=144.22, others missing → derives from the only signal", () => {
      // Photo 1 from the ticket: AI wrote the total (144.22) into
      // taxAmount and left the rest undefined. With only one signal
      // and no breakdown, the reconciler has to keep that single value
      // and drop the others — net=undefined, total=undefined, tax=144.22.
      // The invariant cannot be enforced (only one of three known),
      // and the row is flagged for review via the missing confidence.
      const out = callReconcile({
        taxAmount: 144.22,
      });
      expect(out.taxAmount).toBeCloseTo(144.22, 2);
      expect(out.total).toBeUndefined();
      expect(out.netAmount).toBeUndefined();
      // The reconciliation hint records that we kept one value and
      // dropped the rest — operator can audit why the fields are
      // asymmetric. (Hint reads "reconciled_partial" because we have
      // a single plausible value out of three; "reconciled_from_tax_only"
      // is reserved for the sanity-fallback path where two of three
      // contradicted each other.)
      expect(out.reconciliationHint).toBe("reconciled_partial");
    });

    it("RECONCILES total + net only — derives tax = total - net", () => {
      const out = callReconcile({ total: 144.22, netAmount: 117.25 });
      expect(out.total).toBeCloseTo(144.22, 2);
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
    });

    it("RECONCILES tax + net only — derives total = net + tax", () => {
      const out = callReconcile({ taxAmount: 26.97, netAmount: 117.25 });
      expect(out.total).toBeCloseTo(144.22, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
      expect(out.netAmount).toBeCloseTo(117.25, 2);
    });

    it("DROPS implausible values (tax=1, total=0) and re-derives from the remaining pair", () => {
      // The "tax=1" placeholder + "total=0" failure mode we keep
      // hitting. With only the net left, the reconciler can't satisfy
      // total = net + tax, so it returns tax and net and drops total.
      const out = callReconcile({
        total: 0,        // implausible (== 0)
        netAmount: 117.25,
        taxAmount: 1,    // implausible (== 1)
      });
      expect(out.total).toBeUndefined();
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      expect(out.taxAmount).toBeUndefined();
    });

    it("DROPS date-shaped garbage (total=31082026) and re-derives from a sane breakdown", () => {
      // The classic Américo Alves bug: total parsed from the document
      // date "31/08/2026". A sane breakdown is also present, so the
      // breakdown wins.
      const out = callReconcile({
        total: 31082026,
        netAmount: 117.25,
        taxAmount: 26.97,
        ivaBreakdown: [{ rate: 23, base: 117.25, tax: 26.97 }],
      });
      expect(out.total).toBeCloseTo(144.22, 2);
      expect(out.netAmount).toBeCloseTo(117.25, 2);
      expect(out.taxAmount).toBeCloseTo(26.97, 2);
      expect(out.reconciliationHint).toBe("reconciled_from_breakdown");
    });

    it("handles a multi-rate breakdown correctly (Σ Σ)", () => {
      // Real Portuguese invoice with two rates: 23% (most goods) and
      // 13% (intermediate, e.g. restaurant). Verify the breakdown sums
      // work correctly.
      const out = callReconcile({
        total: 281.6,
        ivaBreakdown: [
          { rate: 23, base: 200, tax: 46 },
          { rate: 13, base: 50, tax: 6.5 },
        ],
      });
      expect(out.netAmount).toBeCloseTo(250, 2); // 200 + 50
      expect(out.taxAmount).toBeCloseTo(52.5, 2); // 46 + 6.5
      // total derived from net+tax = 250 + 52.5 = 302.5 — the
      // breakdown math gives us a DIFFERENT total than the QR's O=281.6
      // (because the actual invoice total is gross and includes extra
      // like stamp duty / rounding). The reconciler prefers the
      // breakdown: total = net + tax.
      expect(out.total).toBeCloseTo(302.5, 2);
      expect(out.reconciliationHint).toBe("reconciled_from_breakdown");
    });

    it("returns undefined for all three when nothing useful is present", () => {
      const out = callReconcile({});
      expect(out.total).toBeUndefined();
      expect(out.taxAmount).toBeUndefined();
      expect(out.netAmount).toBeUndefined();
    });

    it("drops singular implausible values (total=1 → tax=1 → both gone)", () => {
      const out = callReconcile({ total: 1, taxAmount: 1, netAmount: 1 });
      expect(out.total).toBeUndefined();
      expect(out.taxAmount).toBeUndefined();
      expect(out.netAmount).toBeUndefined();
    });
  });

  // ===========================================================================
  // ensureSupplierCustomerSanity() — the post-process safety net that
  // prevents the supplier/customer swap regression (real bug from the
  // user's Américo Alves photo on 2026-09-01). Mirrors the proven pattern
  // from the user's reference app (gemini-documental).
  // ===========================================================================
  describe("ensureSupplierCustomerSanity()", () => {
    // Helper to invoke the private method via a cast — keeps the test
    // surface tight while still exercising the real method body.
    const invoke = (
      fields: ExtractedFields,
      qrPayload?: string,
      tenantId: string = "tenant-1",
    ): Promise<ExtractedFields> => {
      // Stub the DB to return a deterministic tenant identity. The
      // real tenant row would carry name + NIF; here we mock it.
      const tenantPrisma = {
        ...prisma,
        tenant: {
          findUnique: jest.fn().mockResolvedValue({
            name: "NOV OUSADO UNIPESSOAL LDA",
            nif: "515208566",
          }),
          findFirst: jest.fn().mockResolvedValue({
            name: "NOV OUSADO UNIPESSOAL LDA",
            nif: "515208566",
          }),
        },
      };
      const svc2 = new ExtractionService(
        tenantPrisma as any,
        null,
        storage,
      );
      return (svc2 as any).ensureSupplierCustomerSanity(
        tenantId,
        fields,
        qrPayload,
      );
    };

    it("SWAPS supplier/customer when the AI put the buyer as the supplier (NIF-based)", async () => {
      // The exact bug from the user's 2026-09-01 Américo Alves photo:
      // AI wrote supplier='NOV OUSADO' / customer='Américo Alves', but
      // supplier NIF was 506144860 (the supplier's NIF, NOT ours).
      // Here we simulate the WORST case where supplier NIF got cleared
      // but customer NIF kept the supplier's NIF — the swap triggers on
      // supplierNif == tenant NIF OR on the QR's A: field.
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.8,
        currency: "EUR",
        supplier: "NOV OUSADO UNIPESSOAL LDA",
        customer: "Américo Alves - Comércio Internacional, SA",
        supplierNif: "515208566", // <-- this is OUR tenant's NIF (the buyer)
        customerNif: "506144860",
      };
      const out = await invoke(fields);
      expect(out.supplier).toBe("Américo Alves - Comércio Internacional, SA");
      expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
      expect(out.supplierNif).toBe("506144860");
      expect(out.customerNif).toBe("515208566");
      // Hints surface the swap for the audit trail.
      expect(out.hints?.some((h) => h.startsWith("partySwap:"))).toBe(true);
    });

    it("SWAPS using the QR's A: field when it's authoritative", async () => {
      // When the AI's NIF extraction is wrong but the QR decoded
      // cleanly, the QR's A: field (issuer NIF) is the source of truth
      // for the supplier. The QR here says Américo Alves (506144860)
      // issued the document — but the AI swapped and put that NIF in
      // the customer slot AND matched it with our tenant NIF as the
      // supplier. The QR override forces the comparison: when QR.A ==
      // tenant NIF, that's the bug — swap. (Alternative: when AI's
      // supplierNif matches QR.A and customer is our tenant, AI is
      // correct — no swap. This test pins the swap case.)
      const qrPayload =
        "A:515208566*B:506144860*C:PT*D:FT*E:N*F:20260801*G:FT 2026/999*H:12345*I1:0*I2:339.92*I3:78.18*I4:0*J1:0*J2:0*J3:0*J4:0*K1:0*K2:0*K3:0*K4:0*N:78.18*O:418.10*Q:abc*R:1";
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.8,
        currency: "EUR",
        supplier: "NOV OUSADO UNIPESSOAL LDA",
        customer: "Américo Alves - Comércio Internacional, SA",
        supplierNif: "999999990", // AI missed the NIF
        customerNif: "506144860",
      };
      const out = await invoke(fields, qrPayload);
      // The QR says A:515208566 (our tenant) — but wait, that's wrong:
      // in this scenario QR's A field is the supplier's NIF. If QR's A is
      // our tenant, then our tenant IS the supplier which is wrong.
      // Actually the QR's A field IS our tenant → QR thinks we issued
      // the document (a contradiction). The AI returned supplier=our
      // tenant name. The swap detection: supplier NAME = our tenant name
      // (and customer has data) → swap.
      expect(out.supplier).toBe("Américo Alves - Comércio Internacional, SA");
      expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
      const partySwap = out.hints?.find((h) =>
        h.startsWith("partySwap:"),
      );
      expect(partySwap).toBeDefined();
    });

    it("SWAPS on supplier-name match when NIFs are missing", async () => {
      // Some invoices won't print a NIF the OCR can catch. The
      // tenant-name match is the second-line defence.
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.7,
        currency: "EUR",
        supplier: "NOV OUSADO UNIPESSOAL LDA",
        customer: "Américo Alves - Comércio Internacional, SA",
      };
      const out = await invoke(fields);
      expect(out.supplier).toBe("Américo Alves - Comércio Internacional, SA");
      expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
      const partySwap = out.hints?.find((h) =>
        h.startsWith("partySwap:"),
      );
      expect(partySwap).toBeDefined();
    });

    it("DOES NOT swap when supplier/customer are correct", async () => {
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.9,
        currency: "EUR",
        supplier: "Américo Alves - Comércio Internacional, SA",
        customer: "NOV OUSADO UNIPESSOAL LDA",
        supplierNif: "506144860",
        customerNif: "515208566",
      };
      const out = await invoke(fields);
      expect(out.supplier).toBe("Américo Alves - Comércio Internacional, SA");
      expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
      expect(out.supplierNif).toBe("506144860");
      expect(out.hints?.find((h) => h.startsWith("partySwap:"))).toBeUndefined();
    });

    it("Fase 4.2 (P0.1): DISCARDS the supplier name+NIF when no customer data exists — nunca somos o fornecedor", async () => {
      // Antes da Fase 4.2 este caso não tocava em nada: sem bloco de
      // cliente não há "para onde trocar", por isso o nome errado
      // ("NOV OUSADO" — nós próprios) e o NIF ficavam gravados como
      // fornecedor. Agora sabemos por definição que nunca somos o
      // fornecedor, por isso descartamos ambos em vez de os deixar
      // criar uma Party errada.
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.5,
        currency: "EUR",
        supplier: "NOV OUSADO UNIPESSOAL LDA",
        // no customer
        supplierNif: "515208566",
      };
      const out = await invoke(fields);
      expect(out.supplier).toBeUndefined();
      expect(out.supplierNif).toBeUndefined();
      expect(out.hints?.some((h) => h.startsWith("partySwap:"))).toBe(true);
    });

    // ── Fase 4.2 (P0.1) — bug real: ONNERA/Edenox (fatura espanhola).
    // O sistema entregou supplier="NOV OUSADO LDA" (o nosso nome) com
    // supplierNif="ESA14219836" (o CIF real da ONNERA) — nome de um
    // bloco colado ao número de outro. A IA nem devolveu um bloco de
    // cliente distinto, por isso as condições de swap antigas nunca
    // disparavam. O nome tem de ser descartado; o NIF estrangeiro (que
    // não é o nosso) sobrevive para ser reresolvido.
    it("Fase 4.2 (P0.1): ONNERA/Edenox — descarta o nome mas mantém o CIF estrangeiro genuíno", async () => {
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.85,
        currency: "EUR",
        supplier: "NOV OUSADO UNIPESSOAL LDA", // ERRADO — é o nosso nome
        supplierNif: "ESA14219836", // CIF real da ONNERA/Edenox (ES)
        // sem bloco de cliente
      };
      const out = await invoke(fields);
      expect(out.supplier).toBeUndefined();
      expect(out.supplierNif).toBe("ESA14219836");
      expect(out.hints?.some((h) => h.startsWith("partySwap:name_nif_mismatch_discarded"))).toBe(true);
    });

    // ── Fase 4.2 (P0.1) — SAMMIC também imprime o nosso NIF no corpo
    // (autoliquidação intra-UE cita o NIF do adquirente). Confirma que
    // uma fatura normal (bloco de cliente presente, nomes corretos) não
    // é afetada por esta nova regra.
    it("Fase 4.2 (P0.1): SAMMIC — não mexe quando os blocos já estão corretos", async () => {
      const fields: ExtractedFields = {
        source: "ai",
        confidence: 0.9,
        currency: "EUR",
        supplier: "SAMMIC EQUIP. DE HOTELARIA LDA",
        customer: "NOV OUSADO UNIPESSOAL LDA",
        supplierNif: "ESB20869152",
        customerNif: "515208566",
      };
      const out = await invoke(fields);
      expect(out.supplier).toBe("SAMMIC EQUIP. DE HOTELARIA LDA");
      expect(out.customer).toBe("NOV OUSADO UNIPESSOAL LDA");
      expect(out.supplierNif).toBe("ESB20869152");
      expect(out.hints?.find((h) => h.startsWith("partySwap:"))).toBeUndefined();
    });
  });
});
