import { EcbFxService, parseEcbCsv } from "../ecb-fx.service";

const CSV = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,TITLE
EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-02-02,0.8658,A,"Pound sterling/Euro, 2.15 pm (C.E.T.)"
EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-02-03,0.8623,A,"Pound sterling/Euro, 2.15 pm (C.E.T.)"
EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-02-04,0.8616,A,"Pound sterling/Euro, 2.15 pm (C.E.T.)"
`;

describe("EcbFxService (Fase 4)", () => {
  const realFetch = global.fetch;
  let urls: string[];
  beforeEach(() => {
    urls = [];
    global.fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => CSV } as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = realFetch; });

  it("parses the ECB csvdata format (quoted titles with commas) and sorts by date", () => {
    expect(parseEcbCsv(CSV)).toEqual([
      { date: "2026-02-02", value: 0.8658 },
      { date: "2026-02-03", value: 0.8623 },
      { date: "2026-02-04", value: 0.8616 },
    ]);
    expect(parseEcbCsv("")).toEqual([]);
  });

  it("uses the fixing on the invoice date and converts amount / rate", async () => {
    const svc = new EcbFxService();
    const out = await svc.toEur(1000, "GBP", "2026-02-04");
    expect(urls[0]).toContain("/EXR/D.GBP.EUR.SP00.A?startPeriod=2026-01-25&endPeriod=2026-02-04&format=csvdata");
    expect(out).toEqual({ amountEur: 1160.63, rate: { currency: "GBP", rate: 0.8616, rateDate: "2026-02-04" } });
  });

  it("falls back to the latest previous fixing (weekend/holiday) and reports its date", async () => {
    const svc = new EcbFxService();
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => CSV.split("\n").slice(0, 3).join("\n") })) as unknown as typeof fetch;
    const r = await svc.rateToEur("gbp", new Date("2026-02-07T10:00:00Z"));
    expect(r).toEqual({ currency: "GBP", rate: 0.8623, rateDate: "2026-02-03" });
  });

  it("EUR is identity and results are cached per currency+day", async () => {
    const svc = new EcbFxService();
    expect(await svc.rateToEur("EUR", "2026-02-04")).toEqual({ currency: "EUR", rate: 1, rateDate: "2026-02-04" });
    await svc.rateToEur("GBP", "2026-02-04");
    await svc.rateToEur("GBP", "2026-02-04");
    expect(urls).toHaveLength(1);
  });

  it("returns null (never throws) on HTTP errors or unknown currencies", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => "" })) as unknown as typeof fetch;
    const svc = new EcbFxService();
    expect(await svc.rateToEur("XXX", "2026-02-04")).toBeNull();
    expect(await svc.toEur(10, "XXX", "2026-02-04")).toBeNull();
    expect(await svc.rateToEur("GBP", "not-a-date")).toBeNull();
  });
});
