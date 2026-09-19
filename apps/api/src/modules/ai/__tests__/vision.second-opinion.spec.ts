import { ConfigService } from "@nestjs/config";
import { VisionService, type VisionAnalysisResult } from "../vision.service";

/**
 * Fase 2 — second opinion: when the winning provider's confidence is below
 * VISION_SECOND_OPINION_CONFIDENCE (default 0.7) and another provider is
 * configured, exactly ONE extra provider is asked and the more confident
 * answer wins. Transport is stubbed at `tryProvider` so this covers the
 * decision logic only.
 */
function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function result(provider: string, confidence: number, total = 100): VisionAnalysisResult {
  return {
    provider: provider as VisionAnalysisResult["provider"],
    model: "m",
    confidence,
    extracted: { supplier: `${provider}-supplier`, total } as VisionAnalysisResult["extracted"],
    rawResponse: "{}",
    processingTimeMs: 1,
    fallbackUsed: false,
  };
}

const REQ = { mimeType: "image/png", fileBase64: Buffer.from("x").toString("base64"), fileName: "a.png" };

describe("VisionService — second opinion below the confidence threshold (Fase 2)", () => {
  it("asks the next provider when confidence < 0.7 and keeps the more confident result", async () => {
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" }));
    const calls: string[] = [];
    jest.spyOn(svc as any, "tryProvider").mockImplementation(async (p: unknown) => {
      calls.push(p as string);
      return p === "openrouter" ? result("openrouter", 0.55) : result("gemini", 0.9);
    });
    const out = await svc.analyze(REQ as any);
    expect(calls).toEqual(["openrouter", "gemini"]);
    expect(out?.provider).toBe("gemini");
    expect(out?.secondOpinion).toEqual({ provider: "openrouter", confidence: 0.55 });
  });

  it("keeps the primary when the second opinion is not more confident, and records it", async () => {
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" }));
    jest.spyOn(svc as any, "tryProvider").mockImplementation(async (p: unknown) =>
      p === "openrouter" ? result("openrouter", 0.6) : result("gemini", 0.4),
    );
    const out = await svc.analyze(REQ as any);
    expect(out?.provider).toBe("openrouter");
    expect(out?.secondOpinion).toEqual({ provider: "gemini", confidence: 0.4 });
  });

  it("does NOT call a second provider when confidence >= threshold", async () => {
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o" }));
    const spy = jest.spyOn(svc as any, "tryProvider").mockImplementation(async () => result("openrouter", 0.85));
    const out = await svc.analyze(REQ as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out?.secondOpinion).toBeUndefined();
  });

  it("does NOT call a second provider when only one is configured", async () => {
    const svc = new VisionService(makeConfig({ GEMINI_API_KEY: "g" }));
    const spy = jest.spyOn(svc as any, "tryProvider").mockImplementation(async () => result("gemini", 0.2));
    const out = await svc.analyze(REQ as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out?.provider).toBe("gemini");
  });

  it("honours VISION_SECOND_OPINION_CONFIDENCE and survives a failing second provider", async () => {
    const svc = new VisionService(
      makeConfig({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", VISION_SECOND_OPINION_CONFIDENCE: "0.9" }),
    );
    const spy = jest.spyOn(svc as any, "tryProvider").mockImplementation(async (p: unknown) => {
      if (p === "openrouter") return result("openrouter", 0.8);
      throw new Error("gemini down");
    });
    const out = await svc.analyze(REQ as any);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out?.provider).toBe("openrouter");
    expect(out?.secondOpinion).toBeUndefined();
  });
});
