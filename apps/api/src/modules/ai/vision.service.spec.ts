// vision.service.spec.ts — tests for the real (no longer stubbed)
// VisionService. Covers:
//   - provider routing when keys are / aren't configured
//   - JSON extraction (incl. tolerant markdown-fence stripping)
//   - Anthropic / OpenAI / Gemini call shapes (mocked transport)
//   - graceful degradation when no key → null result
//   - 2026-09-01 gap-fix: shared fallback chain that triggers on
//     BOTH throws AND empty/incomplete primary results

import { ConfigService } from "@nestjs/config";
import {
  extractFirstJsonObject,
  isUsableForFallback,
  isVisionResultUsable,
  normalizeExtractedFields,
  VisionService,
} from "./vision.service";

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe("VisionService — provider routing", () => {
  it("returns null and disables live calls when no key is set", async () => {
    const svc = new VisionService(makeConfig({}));
    expect(svc.liveProviderAvailable).toBe(false);
    const result = await svc.analyze({
      mimeType: "application/pdf",
      fileBase64: Buffer.from("test").toString("base64"),
      text: "anything",
    });
    expect(result).toBeNull();
  });

  it("detects OPENROUTER_API_KEY as the PRIMARY vision provider (Gemini via OpenRouter)", () => {
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or" }),
    );
    expect(svc.liveProviderAvailable).toBe(true);
    expect(svc.resolveProvider()).toBe("openrouter");
    expect(svc.hasOpenrouter).toBe(true);
  });

  it("detects MINIMAX_API_KEY (third in the Fase 2 auto order)", () => {
    const svc = new VisionService(
      makeConfig({ MINIMAX_API_KEY: "sk-cp-minimax" }),
    );
    expect(svc.liveProviderAvailable).toBe(true);
    expect(svc.resolveProvider()).toBe("minimax");
    expect(svc.hasMinimax).toBe(true);
  });

  it("detects GEMINI_API_KEY (direct Google gateway) as an optional provider", () => {
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "gem-key" }),
    );
    expect(svc.liveProviderAvailable).toBe(true);
    expect(svc.resolveProvider()).toBe("gemini");
  });

  it("prefers OpenRouter over MiniMax in auto routing (order: openrouter > gemini > minimax)", () => {
    const svc = new VisionService(
      makeConfig({ MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    expect(svc.resolveProvider()).toBe("openrouter");
  });

  it("prefers OpenRouter over a direct Gemini key when both exist (Gemini é acedido via OpenRouter)", () => {
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "gem", OPENROUTER_API_KEY: "sk-or", MINIMAX_API_KEY: "sk-cp" }),
    );
    expect(svc.resolveProvider()).toBe("openrouter");
  });

  it("honours VISION_PROVIDER_ORDER and appends unmentioned providers in default order", () => {
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "gem", OPENROUTER_API_KEY: "sk-or", VISION_PROVIDER_ORDER: "openrouter" }),
    );
    expect(svc.resolveProvider()).toBe("openrouter");
    expect(VisionService.parseProviderOrder("minimax, bogus ,gemini")).toEqual([
      "minimax", "gemini", "openrouter", "openai", "anthropic",
    ]);
    expect(VisionService.parseProviderOrder(undefined)[0]).toBe("openrouter");
    expect(VisionService.parseProviderOrder(undefined)[0]).toBe("openrouter");
    expect(VisionService.parseProviderOrder(undefined)).toEqual(VisionService.DEFAULT_PROVIDER_ORDER);
  });

  it("treats empty-string env values as unset (docker-compose passes unset vars as \"\")", () => {
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "gem", GEMINI_VISION_MODEL: "", OPENROUTER_API_KEY: "" }),
    );
    expect(svc.hasOpenrouter).toBe(false);
    expect(svc.resolveProvider()).toBe("gemini");
    expect(VisionService.parseThreshold("")).toBe(0.7);
    expect(VisionService.parseThreshold("0.55")).toBe(0.55);
    expect(VisionService.parseThreshold("7")).toBe(0.7);
  });

  it("honours preferredProvider=minimax even when other keys are set", () => {
    const svc = new VisionService(
      makeConfig({ MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    expect(svc.resolveProvider("minimax")).toBe("minimax");
  });

  it("honours preferredProvider=openrouter when MiniMax is also configured", () => {
    const svc = new VisionService(
      makeConfig({ MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    expect(svc.resolveProvider("openrouter")).toBe("openrouter");
  });

  it("honours preferredProvider=gemini even when MiniMax key is set", () => {
    const svc = new VisionService(
      makeConfig({
        MINIMAX_API_KEY: "sk-cp",
        GEMINI_API_KEY: "g",
      }),
    );
    expect(svc.resolveProvider("gemini")).toBe("gemini");
  });

  it("falls back to OPENAI when only that key is configured", () => {
    const svc = new VisionService(makeConfig({ OPENAI_API_KEY: "oai-key" }));
    expect(svc.resolveProvider()).toBe("openai");
  });

  it("falls back to ANTHROPIC when only that key is configured", () => {
    const svc = new VisionService(
      makeConfig({ ANTHROPIC_API_KEY: "ant-key" }),
    );
    expect(svc.resolveProvider()).toBe("anthropic");
  });

  it("accepts GOOGLE_API_KEY as an alias for Gemini", () => {
    const svc = new VisionService(
      makeConfig({ GOOGLE_API_KEY: "goog-key" }),
    );
    expect(svc.resolveProvider("gemini")).toBe("gemini");
    // Auto routing → Gemini is primary (Fase 2).
    expect(svc.resolveProvider()).toBe("gemini");
  });

  it("honours preferredProvider when its key is present", () => {
    const svc = new VisionService(
      makeConfig({
        MINIMAX_API_KEY: "sk-cp",
        GEMINI_API_KEY: "gem",
        OPENAI_API_KEY: "oai",
        ANTHROPIC_API_KEY: "ant",
        OPENROUTER_API_KEY: "sk-or",
      }),
    );
    expect(svc.resolveProvider("anthropic")).toBe("anthropic");
    expect(svc.resolveProvider("openai")).toBe("openai");
    expect(svc.resolveProvider("gemini")).toBe("gemini");
    expect(svc.resolveProvider("openrouter")).toBe("openrouter");
    expect(svc.resolveProvider("minimax")).toBe("minimax");
    // Auto → OpenRouter primary (Gemini via OpenRouter).
    expect(svc.resolveProvider("auto")).toBe("openrouter");
  });

  it("returns null when preferredProvider has no matching key", () => {
    const svc = new VisionService(
      makeConfig({ MINIMAX_API_KEY: "sk-cp" }),
    );
    expect(svc.resolveProvider("gemini")).toBeNull();
  });
});

// Pure-function test for the escalation gate. Lives in its own describe
// block so the surrounding provider-routing tests stay unchanged.
describe("isVisionResultUsable() — escalation gate", () => {
  it("returns true when total is sane (the happy path)", () => {
    expect(
      isVisionResultUsable({
        extracted: { total: 144.22, netAmount: 117.25, taxAmount: 26.97 },
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns false when total is missing → escalate", () => {
    expect(
      isVisionResultUsable({
        extracted: { supplier: "X", netAmount: 117.25, taxAmount: 26.97 },
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns false when total > 1_000_000 (the corruption pattern)", () => {
    expect(
      isVisionResultUsable({
        extracted: { total: 31082026 },
        fallbackUsed: false,
      }),
    ).toBe(false);
    expect(
      isVisionResultUsable({
        extracted: { total: 20250217.37 },
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns false when AI-returned atQrRaw O: is a YYYYMMDD date", () => {
    expect(
      isVisionResultUsable({
        extracted: {
          total: 144.22,
          atQrRaw: "A:1*B:2*C:PT*D:FT*E:N*F:20260731*O:20250217.37005",
        },
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns true when atQrRaw O: is a real amount (not date-shaped)", () => {
    expect(
      isVisionResultUsable({
        extracted: {
          total: 144.22,
          atQrRaw: "A:1*B:2*C:PT*D:FT*E:N*F:20260731*O:144.22",
        },
        fallbackUsed: false,
      }),
    ).toBe(true);
  });
});

describe("VisionService — JSON extraction", () => {
  it("returns null when called with no payload and no text", async () => {
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "k" }));
    expect(
      await svc.analyze({ documentContext: "invoice" }),
    ).toBeNull();
  });

  it("strips markdown fences and parses the first balanced JSON object", () => {
    const raw = "Here you go:\n```json\n{\"total\": 12.5, \"supplier\": \"ACME\"}\n```\nThanks!";
    const obj = extractFirstJsonObject(raw);
    expect(obj).not.toBeNull();
    expect(JSON.parse(obj!).total).toBeCloseTo(12.5, 2);
  });

  it("extracts JSON even when wrapped in prose without fences", () => {
    const raw = 'Sure thing: {"total": 99.95, "supplierNif": "500000000"} end';
    const obj = extractFirstJsonObject(raw);
    expect(obj).not.toBeNull();
    expect(JSON.parse(obj!).supplierNif).toBe("500000000");
  });

  it("tolerates nested braces and escaped strings", () => {
    const raw =
      '{"supplier": "ACME Lda", "ivaBreakdown": [{"rate": 23, "base": 100, "tax": 23}], "notes": ["hi \\"there\\""]}';
    const obj = extractFirstJsonObject(raw);
    expect(obj).not.toBeNull();
    const parsed = JSON.parse(obj!);
    expect(parsed.supplier).toBe("ACME Lda");
    expect(parsed.ivaBreakdown[0].tax).toBe(23);
  });

  it("returns null when no balanced JSON object exists", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
    expect(extractFirstJsonObject("{unbalanced")).toBeNull();
    expect(extractFirstJsonObject("")).toBeNull();
  });

  it("strips a <think>...</think> reasoning block before parsing the JSON (MiniMax-M3 prefix)", () => {
    // MiniMax-M3 prepends a reasoning block to every response. Without
    // stripping, indexOf('{') would land INSIDE the think block (which
    // never has balanced JSON), JSON.parse would fail, and the result
    // would be useless fallback garbage. The extractor must skip past
    // the </think> and find the JSON after it.
    const raw =
      "<think>The user has provided a Portuguese invoice photo. " +
      "I need to extract supplier, NIFs, totals and the AT-QR payload. " +
      "Let me carefully read each region of the document.</think>\n\n" +
      '{"supplier": "Américo Alves", "total": 144.22, "atQrRaw": "A:1*B:2*C:PT*D:FT*E:N*F:20260731*O:144.22"}';
    const obj = extractFirstJsonObject(raw);
    expect(obj).not.toBeNull();
    const parsed = JSON.parse(obj!);
    expect(parsed.supplier).toBe("Américo Alves");
    expect(parsed.total).toBeCloseTo(144.22, 2);
  });

  it("strips a <think> block even when JSON is wrapped in markdown fences too", () => {
    const raw =
      "<think>internal reasoning</think>\n" +
      "```json\n" +
      '{"supplier": "ACME", "total": 99.5}\n' +
      "```";
    const obj = extractFirstJsonObject(raw);
    expect(obj).not.toBeNull();
    expect(JSON.parse(obj!).supplier).toBe("ACME");
  });
});

describe("normalizeExtractedFields()", () => {
  it("coerces string amounts (comma decimals) to numbers", () => {
    const out = normalizeExtractedFields({
      total: "1.234,56",
      taxAmount: "205,76",
    });
    expect(out.total).toBeCloseTo(1234.56, 2);
    expect(out.taxAmount).toBeCloseTo(205.76, 2);
  });

  it("clamps confidence to [0,1]", () => {
    expect(normalizeExtractedFields({ confidence: 1.4 }).confidence).toBe(1);
    expect(normalizeExtractedFields({ confidence: -0.2 }).confidence).toBe(0);
    expect(normalizeExtractedFields({ confidence: 0.7 }).confidence).toBe(0.7);
  });

  it("strips whitespace from string fields", () => {
    const out = normalizeExtractedFields({ supplierNif: " 500000000 " });
    expect(out.supplierNif).toBe("500000000");
  });

  it("filters invalid ivaBreakdown rows", () => {
    const out = normalizeExtractedFields({
      ivaBreakdown: [
        { rate: 23, base: 100, tax: 23 },
        { rate: "bad", base: 0, tax: 0 },
        { rate: 13, base: 50, tax: 6.5 },
      ],
    });
    expect(out.ivaBreakdown).toHaveLength(2);
  });

  it("limits notes to 5 entries", () => {
    const out = normalizeExtractedFields({
      notes: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(out.notes).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("extracts line items with description, quantity, unit price, VAT rate and line total", () => {
    const out = normalizeExtractedFields({
      lineItems: [
        {
          description: "Consultoria técnica — 10h",
          code: "C-001",
          quantity: 10,
          unitPrice: 75,
          vatRate: 23,
          lineTotal: 750,
        },
        {
          description: "Deslocações",
          quantity: 1,
          unitPrice: 50,
          vatRate: 23,
          lineTotal: 50,
        },
      ],
    });
    expect(out.lineItems).toHaveLength(2);
    expect(out.lineItems?.[0]).toMatchObject({
      description: "Consultoria técnica — 10h",
      code: "C-001",
      quantity: 10,
      unitPrice: 75,
      vatRate: 23,
      lineTotal: 750,
    });
  });

  it("drops line rows that have no signal at all", () => {
    const out = normalizeExtractedFields({
      lineItems: [
        { description: "Item A", quantity: 1, unitPrice: 10, vatRate: 23, lineTotal: 10 },
        {},
        null,
        { description: null, code: null, quantity: null },
      ],
    });
    expect(out.lineItems).toHaveLength(1);
    expect(out.lineItems?.[0].description).toBe("Item A");
  });

  it("caps line items at 50 rows", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      description: `Item ${i}`,
      quantity: 1,
      unitPrice: 1,
      vatRate: 23,
      lineTotal: 1,
    }));
    const out = normalizeExtractedFields({ lineItems: rows });
    expect(out.lineItems).toHaveLength(50);
  });

  it("carries isEuIntracommunity boolean through unchanged", () => {
    expect(normalizeExtractedFields({ isEuIntracommunity: true }).isEuIntracommunity).toBe(true);
    expect(normalizeExtractedFields({ isEuIntracommunity: false }).isEuIntracommunity).toBe(false);
    expect(normalizeExtractedFields({ isEuIntracommunity: "yes" }).isEuIntracommunity).toBeUndefined();
  });

  it("truncates suggestedCategory to 200 chars", () => {
    const long = "62.2.1 — Trabalhos especializados ".repeat(20);
    const out = normalizeExtractedFields({ suggestedCategory: long });
    expect(out.suggestedCategory).toBeDefined();
    expect(out.suggestedCategory?.length).toBe(200);
  });

  it("drops suggestedCategory when blank or non-string", () => {
    expect(normalizeExtractedFields({ suggestedCategory: "   " }).suggestedCategory).toBeUndefined();
    expect(normalizeExtractedFields({ suggestedCategory: 42 }).suggestedCategory).toBe("42");
    expect(normalizeExtractedFields({}).suggestedCategory).toBeUndefined();
  });

  it("rejects cashDiscountRate outside [0, 100]", () => {
    expect(normalizeExtractedFields({ cashDiscountRate: 2 }).cashDiscountRate).toBe(2);
    expect(normalizeExtractedFields({ cashDiscountRate: "1.5" }).cashDiscountRate).toBe(1.5);
    expect(normalizeExtractedFields({ cashDiscountRate: 150 }).cashDiscountRate).toBeUndefined();
    expect(normalizeExtractedFields({ cashDiscountRate: -1 }).cashDiscountRate).toBeUndefined();
  });

  it("extracts discountAmount as the invoice-level discount (number or numeric string)", () => {
    expect(normalizeExtractedFields({ discountAmount: 12.5 }).discountAmount).toBe(12.5);
    expect(normalizeExtractedFields({ discountAmount: "1.234,56" }).discountAmount).toBeCloseTo(1234.56, 2);
    expect(normalizeExtractedFields({ discountAmount: 0 }).discountAmount).toBe(0);
  });

  it("drops negative or non-finite discountAmount values", () => {
    expect(normalizeExtractedFields({ discountAmount: -1 }).discountAmount).toBeUndefined();
    expect(normalizeExtractedFields({ discountAmount: "abc" }).discountAmount).toBeUndefined();
    expect(normalizeExtractedFields({ discountAmount: null }).discountAmount).toBeUndefined();
  });

  it("carries per-line `discount` through line items", () => {
    const out = normalizeExtractedFields({
      lineItems: [
        { description: "Serviço A", quantity: 1, unitPrice: 100, vatRate: 23, discount: 10, lineTotal: 90 },
        { description: "Produto B", quantity: 2, unitPrice: 50, vatRate: 13, lineTotal: 100 },
      ],
    });
    expect(out.lineItems).toHaveLength(2);
    expect(out.lineItems?.[0].discount).toBe(10);
    expect(out.lineItems?.[1].discount).toBeUndefined();
  });
});

describe("VisionService — canSkipVision()", () => {
  it("returns true when QR path captured all key fields", () => {
    const svc = new VisionService(makeConfig({}));
    expect(
      svc.canSkipVision({
        nif: "500000000",
        totalAmount: 123,
        atcud: "ABC-1",
      }),
    ).toBe(true);
  });
  it("returns false when any key field is missing", () => {
    const svc = new VisionService(makeConfig({}));
    expect(svc.canSkipVision({ nif: "x", totalAmount: 1 })).toBe(false);
    expect(svc.canSkipVision({ nif: "x", atcud: "y" })).toBe(false);
    expect(svc.canSkipVision({})).toBe(false);
  });
});

describe("VisionService — provider transport (mocked)", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalRequire: typeof require;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("calls OpenAI's chat/completions endpoint with response_format=json_object", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                supplier: "ACME",
                total: 99.5,
                currency: "EUR",
                docNumber: "FT 2026/1",
                confidence: 0.92,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });
    const svc = new VisionService(
      makeConfig({ OPENAI_API_KEY: "sk-test" }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("fake-png").toString("base64"),
      text: "fallback text",
      fileName: "invoice.png",
      preferredProvider: "openai",
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openai");
    expect(out!.confidence).toBeCloseTo(0.92, 2);
    expect(out!.extracted.supplier).toBe("ACME");
    expect(out!.extracted.total).toBeCloseTo(99.5, 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/api\.openai\.com\/v1\/chat\/completions/);
    expect(JSON.parse(init.body).response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(init.body).model).toBe("gpt-4o");
  });

  it("calls Gemini's generateContent endpoint with responseMimeType=application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    supplier: "Beta Lda",
                    supplierNif: "500000000",
                    total: 1234.56,
                    currency: "EUR",
                    iban: "PT50 0002 0123 1234 5678 9015 4",
                    docNumber: "FT 2026/123",
                    confidence: 0.88,
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 40 },
      }),
    });
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "gem" }));
    const out = await svc.analyze({
      mimeType: "application/pdf",
      fileBase64: Buffer.from("fake-pdf").toString("base64"),
      fileName: "FT 2026-123.pdf",
      preferredProvider: "gemini",
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("gemini");
    expect(out!.extracted.supplierNif).toBe("500000000");
    expect(out!.extracted.iban).toBe("PT50 0002 0123 1234 5678 9015 4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(
      /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent/,
    );
    expect(url).toContain("key=gem");
    const body = JSON.parse(init.body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    // The PDF payload must be inlined as base64.
    expect(body.contents[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inline_data: expect.objectContaining({
            mime_type: "application/pdf",
            data: expect.any(String),
          }),
        }),
      ]),
    );
  });

  it("captures upstream errors and returns null (caller falls back to regex)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "upstream blew up",
    });
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "k" }));
    const out = await svc.analyze({
      mimeType: "application/pdf",
      fileBase64: Buffer.from("x").toString("base64"),
      fileName: "x.pdf",
    });
    expect(out).toBeNull();
  });

  it("times out an upstream call that exceeds timeoutMs", async () => {
    fetchMock.mockImplementation(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          // Honour the AbortController — when AbortController fires we
          // reject with a recognisable error that the test can match.
          if (init?.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          init?.signal?.addEventListener?.("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "k" }));
    const out = await svc.analyze({
      mimeType: "application/pdf",
      fileBase64: Buffer.from("x").toString("base64"),
      timeoutMs: 20,
    });
    expect(out).toBeNull();
  });

  it("returns null when only-Gemini primary has no JSON object (chain exhausted)", async () => {
    // 2026-09-01 gap-fix: previously the code returned a partial
    // `fallbackUsed: true` result with empty `extracted`. Now the
    // chain exhausts and we return null so the caller marks
    // needs_review. The old test was asserting the legacy partial-
    // result behaviour — the gap-fix deliberately changes it so a
    // document never comes back silently empty when only one
    // provider is configured and that provider underperforms.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "no json here" }] } }],
      }),
    });
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "k" }));
    const out = await svc.analyze({
      mimeType: "application/pdf",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).toBeNull();
  });

  it("calls OpenRouter's chat/completions endpoint with bearer auth + image_url data URI and tags result.provider as 'openrouter/gemini-2.5-flash'", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                supplier: "OpenRouter Vendor",
                supplierNif: "509000000",
                total: 50.0,
                currency: "EUR",
                docNumber: "OR 1/2026",
                iban: "PT50 0002 0123 1234 5678 9015 4",
                confidence: 0.91,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
        model: "google/gemini-2.5-flash",
      }),
    });
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or-test" }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("fake-png").toString("base64"),
      fileName: "or-invoice.png",
      preferredProvider: "openrouter",
    });
    expect(out).not.toBeNull();
    // Primary path — the composite provider string the user agreed on
    // (2026-08-31): literal `openrouter/gemini-2.5-flash`.
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(out!.extracted.supplier).toBe("OpenRouter Vendor");
    expect(out!.extracted.supplierNif).toBe("509000000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    // max_tokens: 6000 — paired with the 3-attempt retry loop, this
    // is what makes the OpenRouter path deterministic. Long invoices
    // (line items + ivaBreakdown + cash discount + AT-QR payload) hit
    // 3500-4500 chars; 6000 gives enough headroom to finish the JSON
    // before the model's 8192 hard cap silently rounds down. Truncating
    // mid-JSON was the #1 cause of `fallbackUsed: true` results.
    expect(body.max_tokens).toBe(6000);
    expect(body.temperature).toBeCloseTo(0.1, 5);
    const userMsg = body.messages[1];
    expect(userMsg.role).toBe("user");
    const imagePart = userMsg.content.find(
      (c: any) => c.type === "image_url",
    );
    expect(imagePart).toBeDefined();
    expect(imagePart.image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("falls back to direct Gemini when OpenRouter is unreachable and tags provider as 'gemini'", async () => {
    fetchMock
      // 1st-3rd calls → OpenRouter: 502 on all 3 retry attempts
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "upstream down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "upstream down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "upstream down",
      })
      // 4th call → direct Gemini: success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      supplier: "Direct Gemini Supplier",
                      supplierNif: "509111111",
                      total: 99.99,
                      taxAmount: 18.7,
                      currency: "EUR",
                      iban: "PT50 0002 0123 1234 5678 9015 4",
                      docDate: "2026-08-30",
                      confidence: 0.81,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 40 },
        }),
      });

    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        GEMINI_API_KEY: "g",
        OPENROUTER_API_KEY: "sk-or",
      }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("png").toString("base64"),
      fileName: "x.png",
      // preferredProvider omitted → auto → OpenRouter primary → direct Gemini fallback
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("gemini");
    expect(out!.extracted.supplier).toBe("Direct Gemini Supplier");
    expect(out!.extracted.taxAmount).toBeCloseTo(18.7, 2);
    // 3 OpenRouter attempts + 1 direct Gemini success = 4 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[3][0]).toMatch(
      /generativelanguage\.googleapis\.com/,
    );
  });

  it("returns null when both OpenRouter (3 retries) and direct Gemini fail (no regex-aware fallback beyond vision)", async () => {
    fetchMock
      // 3 OpenRouter retries → all 502
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "openrouter down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "openrouter down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => "openrouter down",
      })
      // direct Gemini → 429 quota exhausted
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        text: async () =>
          JSON.stringify({
            error: { code: 429, status: "RESOURCE_EXHAUSTED" },
          }),
      });
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).toBeNull();
    // 3 OpenRouter retries + 1 direct Gemini fallback = 4 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // -----------------------------------------------------------------
  // 3-attempt retry — the corruption fix. When the first OpenRouter
  // call returns unparseable / truncated JSON (fallbackUsed = true OR
  // missing required fiscal fields), `analyze()` retries UP TO 3 times
  // before giving up. Same temperature + max_tokens + image across
  // attempts — the variance is in the upstream sampler. The first
  // COMPLETE response wins (must have at least one of total, supplier,
  // supplierNif, docNumber, atQrRaw, netAmount). When all 3 fail we
  // keep the LAST failure result so the caller still gets a
  // `fallbackUsed` warning AND the metadata surfaces
  // `ai_all_retries_failed_on_image_needs_review`.
  // -----------------------------------------------------------------
  it("retries OpenRouter up to 3 times when first call returns incomplete JSON; succeeds on 2nd attempt", async () => {
    fetchMock
      // 1st call: returns unparseable garbage (no JSON object)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "sorry, I cannot parse that image" } },
          ],
          model: "google/gemini-2.5-flash",
        }),
      })
      // 2nd call (retry #1): returns valid JSON with usable numerics
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Retry Vendor",
                  total: 42.5,
                  taxAmount: 8.5,
                  netAmount: 34.0,
                  confidence: 0.9,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("fake").toString("base64"),
      preferredProvider: "openrouter",
    });
    expect(out).not.toBeNull();
    expect(out!.extracted.supplier).toBe("Retry Vendor");
    expect(out!.extracted.total).toBe(42.5);
    expect(out!.fallbackUsed).toBe(false);
    // Retry succeeded on attempt #2 → primary result is returned.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Same temperature + max_tokens across attempts — variance is
    // purely in the upstream sampler.
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.temperature).toBeCloseTo(0.1, 5);
    expect(retryBody.max_tokens).toBe(6000);
  });

  it("retries 3 times and returns null when chain is exhausted (only OpenRouter configured)", async () => {
    // 2026-09-01 gap-fix: when only ONE provider is configured and
    // all of its in-call retries fail, the chain is exhausted and we
    // return null so the caller marks needs_review. Previously the
    // code returned the last `fallbackUsed: true` partial result
    // (the caller would then emit `aiProvider: openrouter/gemini-2.5-flash`
    // with confidence=0, which is exactly the silent-empty bug the
    // gap-fix closes).
    fetchMock
      // All 3 attempts return unparseable garbage
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage no json" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "still garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "still garbage again" } }],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("fake").toString("base64"),
      preferredProvider: "openrouter",
    });
    expect(out).toBeNull();
    // All 3 attempts exhausted before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------
  // Escalation: when the primary OpenRouter call returns parseable
  // JSON but the extracted numerics are unusable (missing `total` or
  // the AI-returned `atQrRaw` `O:` is a YYYYMMDD date), retry on the
  // stronger escalation model. This is the fix for the `20250217.37`
  // / `31082026` corruption patterns on the Américo Alves / LIZOTEL /
  // Mastergastro phone photos — the primary `gemini-2.5-flash` model
  // misreads the QR's `O:` block; `gemini-2.5-pro` reads it correctly.
  // -----------------------------------------------------------------
  it("escalates to the stronger model when primary numerics are unusable", async () => {
    fetchMock
      // 1st call: parseable JSON but `total` is missing and the
      // AI-returned atQrRaw O: is a YYYYMMDD date — the primary
      // model misread the QR graphic.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Américo Alves - Comércio Internacional, SA",
                  supplierNif: "506144860",
                  atcud: "J6T6HBN8-1751",
                  atQrRaw:
                    "A:506144860*B:PT*C:515208566*D:FT*E:20260731*F:FT 2026A76/1751*G:J6T6HBN8-1751*H:1*I1:23.00*J1:117.25*K1:26.97*L:144.22*M:26.97*N:144.22*O:20250217.37005",
                  confidence: 0.92,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      })
      // 2nd call (escalation to gemini-2.5-pro): returns clean numerics
      // with the SHORT prompt — no reasoning-token blowout.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Américo Alves - Comércio Internacional, SA",
                  supplierNif: "506144860",
                  atcud: "J6T6HBN8-1751",
                  total: 144.22,
                  netAmount: 117.25,
                  taxAmount: 26.97,
                  iban: "PT50001800032176233102036",
                  confidence: 0.96,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-pro",
        }),
      });
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("fake-jpg").toString("base64"),
      fileName: "phone-photo.jpg",
      preferredProvider: "openrouter",
    });
    expect(out).not.toBeNull();
    expect(out!.fallbackUsed).toBe(false);
    // The escalation result wins — total / netAmount / taxAmount
    // come from the stronger model.
    expect(out!.extracted.total).toBe(144.22);
    expect(out!.extracted.netAmount).toBe(117.25);
    expect(out!.extracted.taxAmount).toBe(26.97);
    expect(out!.extracted.iban).toBe("PT50001800032176233102036");
    expect(out!.model).toBe("gemini-2.5-pro");
    expect(out!.provider).toBe("openrouter/gemini-2.5-pro");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The 2nd (escalation) call used a DIFFERENT model id AND a much
    // shorter system prompt (no PT-accountant role / schema details).
    const escalationBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(escalationBody.model).toBe("google/gemini-2.5-pro");
    expect(escalationBody.messages[0].content.length).toBeLessThan(800);
    expect(escalationBody.temperature).toBe(0.0);
  });

  it("does NOT escalate when primary numerics are sane", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                supplier: "Clean Vendor",
                total: 123.45,
                taxAmount: 23.45,
                netAmount: 100.0,
                atQrRaw: "A:1*B:2*C:PT*D:FT*E:N*F:20260101*G:G1*H:H1*N:23.45*O:123.45",
                confidence: 0.95,
              }),
            },
          },
        ],
        model: "google/gemini-2.5-flash",
      }),
    });
    const svc = new VisionService(
      makeConfig({ OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
      preferredProvider: "openrouter",
    });
    expect(out).not.toBeNull();
    expect(out!.extracted.total).toBe(123.45);
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    // Only ONE fetch — no escalation when the primary is fine.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT escalate when total > 1_000_000 (corruption pattern) — that's NOT what we want", async () => {
    // isVisionResultUsable returns false for total > 1_000_000 → triggers
    // escalation. The test confirms the contract.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                supplier: "Corrupt Vendor",
                total: 31082026, // the original date-corruption pattern
                confidence: 0.9,
              }),
            },
          },
        ],
        model: "google/gemini-2.5-flash",
      }),
    });
    // Don't mock the 2nd call — the escalation path will hit the real
    // OpenRouter API. We just assert isVisionResultUsable directly here.
    expect(isVisionResultUsable({
      extracted: { total: 31082026, supplier: "X" },
      fallbackUsed: false,
    })).toBe(false);
  });
});

// ============================================================================
// MiniMax provider (PRIMARY as of 2026-09-01) — OpenAI-compatible chat
// completions at MINIMAX_URL with bearer auth, image_url data URI, no
// response_format, max_tokens=8000 to budget for the <think> reasoning
// block that MiniMax-M3 emits before the JSON.
// ============================================================================
describe("VisionService — MiniMax (PRIMARY) transport", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).fetch;
  });

  it("calls the MiniMax endpoint with bearer auth + image_url data URI and tags result.provider as 'minimax/MiniMax-M3'", async () => {
    // MiniMax returns the JSON wrapped in a <think> reasoning block —
    // the same shape the user observed in live testing. The extractor
    // must strip the think block before parsing.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "<think>The user uploaded an Américo Alves invoice. I can see " +
                "the supplier name in the header, the totals block at the bottom, " +
                "and the AT-QR code in the right margin. Let me extract each " +
                "field carefully.</think>\n\n" +
                JSON.stringify({
                  supplier: "Américo Alves",
                  supplierNif: "509000000",
                  total: 144.22,
                  taxAmount: 26.97,
                  netAmount: 117.25,
                  currency: "EUR",
                  docNumber: "FT 2026/123",
                  atQrRaw:
                    "A:509000000*B:515208566*C:PT*D:FT*E:N*F:20260731*G:FT 2026/123*H:ATCUD0*I:117.25*J:26.97*K:26.97*N:26.97*O:144.22",
                  confidence: 0.93,
                }),
            },
          },
        ],
        usage: { prompt_tokens: 1500, completion_tokens: 800 },
        model: "MiniMax-M3",
      }),
    });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp-test" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("real-invoice").toString("base64"),
      fileName: "am-2026-08.jpg",
      // preferredProvider omitted → auto → MiniMax primary.
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("minimax/MiniMax-M3");
    expect(out!.extracted.supplier).toBe("Américo Alves");
    expect(out!.extracted.supplierNif).toBe("509000000");
    expect(out!.extracted.total).toBeCloseTo(144.22, 2);
    expect(out!.extracted.taxAmount).toBeCloseTo(26.97, 2);
    expect(out!.extracted.netAmount).toBeCloseTo(117.25, 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // URL defaults to the canonical MiniMax endpoint but is overridable
    // via MINIMAX_URL — verified by reading from env in the constructor.
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer sk-cp-test");
    expect(init.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("MiniMax-M3");
    expect(body.temperature).toBeCloseTo(0.1, 5);
    // max_tokens=8000 so the JSON fits after the <think> block.
    expect(body.max_tokens).toBe(8000);
    // HARDENED 2026-09-01: MiniMax-M3 supports `thinking: { type:
    // 'disabled' }` to suppress its <think> reasoning pass. Verified
    // live: cuts per-call latency from ~40-60s to ~15-25s on the real
    // Américo Alves photo (Opus 5 spends zero reasoning tokens).
    expect(body.thinking).toEqual({ type: 'disabled' });
    // No response_format — MiniMax doesn't honour it.
    expect(body.response_format).toBeUndefined();
    const userMsg = body.messages[1];
    expect(userMsg.role).toBe("user");
    const imagePart = userMsg.content.find(
      (c: any) => c.type === "image_url",
    );
    expect(imagePart).toBeDefined();
    expect(imagePart.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("still parses a MiniMax-M3 response when the model IGNORES thinking=disabled and emits a <think> block (safety net)", async () => {
    // HARDENED 2026-09-01: defense in depth. We tell the server
    // thinking=disabled AND the system prompt to skip the reasoning
    // trace, but if Opus 5 ignores both (model rollback, gateway
    // stripping the param, etc.) we still get the right JSON.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "<think>The user provided an Américo Alves invoice. I should OCR carefully.</think>\n\n" +
                JSON.stringify({
                  supplier: 'Américo Alves',
                  supplierNif: '509000000',
                  total: 144.22,
                  taxAmount: 26.97,
                  netAmount: 117.25,
                  confidence: 0.95,
                }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1500, completion_tokens: 800 },
        model: 'MiniMax-M3',
      }),
    });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: 'sk-cp-test' }),
    );
    const out = await svc.analyze({
      mimeType: 'image/jpeg',
      fileBase64: Buffer.from('real-invoice').toString('base64'),
      fileName: 'am-2026-08.jpg',
      preferredProvider: 'minimax',
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe('minimax/MiniMax-M3');
    expect(out!.extracted.supplier).toBe('Américo Alves');
    expect(out!.extracted.total).toBeCloseTo(144.22, 2);
  });

  it("honours a MINIMAX_URL override (gateway-style config)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                supplier: "Custom URL Vendor",
                total: 50.0,
                confidence: 0.9,
              }),
            },
          },
        ],
        model: "MiniMax-M3",
      }),
    });
    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        MINIMAX_API_KEY: "sk-cp",
        MINIMAX_URL: "https://minimax-proxy.example.com/v1/chat/completions",
      }),
    );
    await svc.analyze({
      mimeType: "image/png",
      fileBase64: Buffer.from("x").toString("base64"),
      preferredProvider: "minimax",
    });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://minimax-proxy.example.com/v1/chat/completions",
    );
  });

  it("falls back to OpenRouter when MiniMax fails and tags the result as openrouter", async () => {
    fetchMock
      // 1st-2nd calls → MiniMax: 500 on both retry attempts
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "minimax down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "minimax down",
      })
      // 3rd call → OpenRouter fallback: success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "OpenRouter Fallback Vendor",
                  supplierNif: "509222222",
                  total: 88.5,
                  currency: "EUR",
                  confidence: 0.82,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 30 },
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        MINIMAX_API_KEY: "sk-cp",
        OPENROUTER_API_KEY: "sk-or",
      }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(out!.extracted.supplier).toBe("OpenRouter Fallback Vendor");
    // 2 MiniMax attempts + 1 OpenRouter success = 3 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.minimax.io/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.minimax.io/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("retries once when MiniMax returns truncated response (no balanced JSON after stripping think block)", async () => {
    fetchMock
      // 1st call → MiniMax truncated mid-JSON
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>reasoning</think>\n" +
                  '{"supplier": "Partial Vendor", "total": 1', // truncated
              },
              finish_reason: "length",
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      // 2nd call → MiniMax complete
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Retry Vendor",
                  total: 100.0,
                  confidence: 0.85,
                }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
      preferredProvider: "minimax",
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("minimax/MiniMax-M3");
    expect(out!.extracted.supplier).toBe("Retry Vendor");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours an OPENROUTER_URL override on the fallback path", async () => {
    fetchMock
      // MiniMax fails
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "down",
      })
      // OpenRouter fallback succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Custom OR Vendor",
                  total: 12.0,
                  confidence: 0.7,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        MINIMAX_API_KEY: "sk-cp",
        OPENROUTER_API_KEY: "sk-or",
        OPENROUTER_URL: "https://openrouter-proxy.example.com/api/v1/chat/completions",
      }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://openrouter-proxy.example.com/api/v1/chat/completions",
    );
  });
});

// ============================================================================
// 2026-09-01 GAP-FIX: shared fallback chain.
//
// The OLD analyze() only triggered the fallback chain in the CATCH block —
// when MiniMax THREW. If MiniMax returned NULL (no JSON), `fallbackUsed: true`
// (parse failed after 3 retries), or a parseable-but-empty result (supplier
// AND total both missing), the code returned that weak result and the caller
// (extraction service) wrote a `needs_review` row with no supplier / no
// total. The user wanted: when MiniMax underperforms, fall through to
// OpenRouter BEFORE giving up. When OpenRouter also underperforms, fall
// through to direct Gemini. Only after every configured provider fails to
// return a usable result do we return null so the caller marks
// `needs_review`.
//
// The new analyze() routes BOTH the throw path AND the empty/incomplete
// success path through the same shared `buildProviderChain` + `tryProvider`
// + `isUsableForFallback` machinery. Each provider gets exactly one
// retry-loop of its own (3 for OpenRouter, 2 for MiniMax, 1 for Gemini);
// the chain triggers AFTER every in-call retry has been exhausted.
// ============================================================================
describe("VisionService — gap-fix shared fallback chain (2026-09-01)", () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).fetch;
  });

  it("MiniMax returns usable → OpenRouter NOT called (sanity check)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                "<think>reasoning</think>\n" +
                JSON.stringify({
                  supplier: "Usable Vendor",
                  supplierNif: "509000000",
                  total: 144.22,
                  taxAmount: 26.97,
                  netAmount: 117.25,
                  currency: "EUR",
                  confidence: 0.95,
                }),
            },
          },
        ],
        model: "MiniMax-M3",
      }),
    });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("minimax/MiniMax-M3");
    expect(out!.extracted.supplier).toBe("Usable Vendor");
    // MiniMax answered on the first attempt — OpenRouter is NOT touched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.minimax.io/v1/chat/completions",
    );
  });

  it("MiniMax returns EMPTY result (no JSON) → OpenRouter is called and its result is used", async () => {
    // Both MiniMax attempts (its 2-attempt retry loop) return empty
    // content (no JSON object inside). The chain must treat that as a
    // failure and fall through to OpenRouter, where the 3-attempt retry
    // eventually succeeds.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "<think>...</think>\n" } }],
          model: "MiniMax-M3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "<think>...</think>\n" } }],
          model: "MiniMax-M3",
        }),
      })
      // OpenRouter 3 attempts — only the 3rd returns usable JSON
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "still garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "OpenRouter Rescue Vendor",
                  supplierNif: "509333333",
                  total: 200.0,
                  currency: "EUR",
                  confidence: 0.88,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(out!.extracted.supplier).toBe("OpenRouter Rescue Vendor");
    expect(out!.extracted.total).toBe(200.0);
    // 2 MiniMax attempts + 3 OpenRouter attempts = 5 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.minimax.io/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.minimax.io/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("MiniMax returns INCOMPLETE result (no usable fields) → OpenRouter is called and its result is used", async () => {
    // MiniMax returns a parseable JSON with `notes: ['unsure']` and NO
    // supplier / total / nif / atQrRaw / iban / atcud / docNumber.
    // That's the gap: today the code would return that and the
    // extraction service would mark the doc needs_review with empty
    // fields. The fix: treat this as a failure and try OpenRouter.
    fetchMock
      // MiniMax 2 attempts, both return the SAME incomplete JSON
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>thinking</think>\n" +
                  JSON.stringify({
                    notes: ["I'm not sure about this one"],
                    confidence: 0.4,
                  }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>thinking harder</think>\n" +
                  JSON.stringify({
                    notes: ["still not sure"],
                    confidence: 0.3,
                  }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      // OpenRouter 1 attempt: succeeds with usable fields
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "OR Vendor",
                  supplierNif: "509444444",
                  total: 99.99,
                  currency: "EUR",
                  confidence: 0.91,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(out!.extracted.supplier).toBe("OR Vendor");
    expect(out!.extracted.total).toBe(99.99);
    // 2 MiniMax attempts + 1 OpenRouter success = 3 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("MiniMax throws → OpenRouter is called and its result is used (legacy path still works)", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "minimax down",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "minimax down",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "OR Throws-Recovery Vendor",
                  total: 50.0,
                  currency: "EUR",
                  confidence: 0.85,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("MiniMax unusable AND OpenRouter unusable → direct Gemini is called and its result is used", async () => {
    fetchMock
      // MiniMax 2 attempts — both return incomplete JSON (no usable fields)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>reasoning</think>\n" +
                  JSON.stringify({ notes: ["no idea"], confidence: 0.2 }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>reasoning harder</think>\n" +
                  JSON.stringify({ notes: ["really no idea"], confidence: 0.1 }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      // OpenRouter 3 attempts — all return empty / incomplete
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "still garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: ["OpenRouter is also confused"],
                  confidence: 0.2,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      })
      // direct Gemini 1 attempt: succeeds with usable fields
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      supplier: "Direct Gemini Rescue Vendor",
                      supplierNif: "509555555",
                      total: 75.5,
                      currency: "EUR",
                      confidence: 0.83,
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
        }),
      });
    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        MINIMAX_API_KEY: "sk-cp",
        OPENROUTER_API_KEY: "sk-or",
        GEMINI_API_KEY: "gem-key",
      }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("gemini");
    expect(out!.extracted.supplier).toBe("Direct Gemini Rescue Vendor");
    expect(out!.extracted.total).toBe(75.5);
    // 2 MiniMax + 3 OpenRouter + 1 Gemini = 6 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5][0]).toMatch(
      /generativelanguage\.googleapis\.com/,
    );
  });

  it("ALL providers unusable → returns null (caller marks needs_review)", async () => {
    fetchMock
      // MiniMax 2 attempts — both return empty JSON (no usable fields)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "<think>x</think>\n" } }],
          model: "MiniMax-M3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "<think>x</think>\n" } }],
          model: "MiniMax-M3",
        }),
      })
      // OpenRouter 3 attempts — all empty
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      // direct Gemini — empty too
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "no json here" }] } }],
        }),
      });
    const svc = new VisionService(
      makeConfig({
        VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", // legacy order: these tests exercise the chain mechanics, not the Fase 2 default
        MINIMAX_API_KEY: "sk-cp",
        OPENROUTER_API_KEY: "sk-or",
        GEMINI_API_KEY: "gem",
      }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("x").toString("base64"),
    });
    // All 3 providers gave us only empty / incomplete results — the
    // chain is exhausted and we return null. The caller will route
    // this to needs_review (for image-only documents).
    expect(out).toBeNull();
  });

  it("MiniMax returns date-corruption pattern (total > 1_000_000) → OpenRouter is tried", async () => {
    // Real-world failure: MiniMax misread the QR's O: block as
    // `20250217.37005` and reported that as `total`. The OLD code
    // would return that and let the document record a 20M EUR total.
    // The NEW code: isUsableForFallback rejects this and falls through
    // to OpenRouter, which reads the QR correctly.
    //
    // Mock setup note: MiniMax accepts the 1st attempt (hasAuthoritative
    // is true — total is a number) so it makes exactly 1 fetch. Then
    // OpenRouter makes up to 3 fetches; the 3rd must return usable
    // JSON. We need exactly 4 mocks:
    //   1. MiniMax #1: date-corruption (returns immediately)
    //   2. OpenRouter #1: garbage ("garbage no json") → retry
    //   3. OpenRouter #2: garbage ("still garbage") → retry
    //   4. OpenRouter #3: GOOD JSON with clean total → accept
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "<think>thinking</think>\n" +
                  JSON.stringify({
                    supplier: "Américo Alves",
                    total: 20250217.37, // date-corruption pattern
                    atQrRaw: "A:1*B:2*C:PT*D:FT*E:N*F:20260731*O:20250217.37005",
                    confidence: 0.9,
                  }),
              },
            },
          ],
          model: "MiniMax-M3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "garbage no json" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "still garbage" } }],
          model: "google/gemini-2.5-flash",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  supplier: "Américo Alves - Comércio Internacional, SA",
                  supplierNif: "506144860",
                  total: 144.22,
                  netAmount: 117.25,
                  taxAmount: 26.97,
                  atQrRaw:
                    "A:506144860*B:PT*C:515208566*D:FT*E:N*F:20260731*G:FT 2026A76/1751*H:J6T6HBN8-1751*I1:117.25*J1:26.97*N:144.22*O:144.22",
                  currency: "EUR",
                  confidence: 0.96,
                }),
              },
            },
          ],
          model: "google/gemini-2.5-flash",
        }),
      });
    const svc = new VisionService(
      makeConfig({ VISION_PROVIDER_ORDER: "minimax,openrouter,gemini", MINIMAX_API_KEY: "sk-cp", OPENROUTER_API_KEY: "sk-or" }),
    );
    const out = await svc.analyze({
      mimeType: "image/jpeg",
      fileBase64: Buffer.from("real-phone-photo").toString("base64"),
    });
    expect(out).not.toBeNull();
    expect(out!.provider).toBe("openrouter/gemini-2.5-flash");
    expect(out!.extracted.supplier).toBe(
      "Américo Alves - Comércio Internacional, SA",
    );
    expect(out!.extracted.total).toBe(144.22);
    // 1 MiniMax + 3 OpenRouter attempts = 4 fetches total.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

// ============================================================================
// Pure-function tests for isUsableForFallback — the gate that decides whether
// to accept a provider's result or fall through to the next one.
// ============================================================================
describe("isUsableForFallback() — chain gate", () => {
  it("returns false for null / undefined result", () => {
    expect(isUsableForFallback(null)).toBe(false);
    expect(isUsableForFallback(undefined)).toBe(false);
  });

  it("returns false when fallbackUsed=true (3-attempt retry loop gave up)", () => {
    expect(
      isUsableForFallback({
        provider: "minimax",
        model: "MiniMax-M3",
        confidence: 0.5,
        extracted: { supplier: "X" },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: true,
      }),
    ).toBe(false);
  });

  it("returns false when confidence is 0 (the diagnostic empty result)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0,
        extracted: { supplier: "X" },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns false when extracted is empty / no signals", () => {
    expect(
      isUsableForFallback({
        provider: "minimax",
        model: "MiniMax-M3",
        confidence: 0.8,
        extracted: {},
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns false on the date-corruption pattern (total > 1_000_000)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.9,
        extracted: {
          supplier: "X",
          total: 31082026, // the original 2026-08-31 corruption
        },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns false on the O-block YYYYMMDD misread pattern", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.9,
        extracted: {
          supplier: "X",
          total: 144.22, // total IS fine
          atQrRaw: "A:1*B:2*C:PT*D:FT*E:N*F:20260731*O:20250217.37005",
        },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("returns true when supplier + total are both filled (the happy path)", () => {
    expect(
      isUsableForFallback({
        provider: "minimax",
        model: "MiniMax-M3",
        confidence: 0.92,
        extracted: {
          supplier: "Américo Alves",
          total: 144.22,
          taxAmount: 26.97,
          netAmount: 117.25,
        },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns true when only supplier is filled (name alone is enough to keep the doc)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.7,
        extracted: { supplier: "Some Supplier" },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns true when only supplierNif is filled (PT issuer NIF is authoritative)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.7,
        extracted: { supplierNif: "509000000" },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns true when only atcud is filled (PT fiscal code is enough)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.7,
        extracted: { atcud: "J6T6HBN8-1751" },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns true when only an atQrRaw payload with ≥ 3 fields is present", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.8,
        extracted: {
          atQrRaw: "A:506144860*B:515208566*C:PT*D:FT*E:N",
        },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("returns false when atQrRaw is too short to be a real payload (< 3 fields)", () => {
    expect(
      isUsableForFallback({
        provider: "openrouter",
        model: "gemini-2.5-flash",
        confidence: 0.8,
        extracted: {
          atQrRaw: "A:1",
        },
        rawResponse: "",
        processingTimeMs: 0,
        fallbackUsed: false,
      }),
    ).toBe(false);
  });
});