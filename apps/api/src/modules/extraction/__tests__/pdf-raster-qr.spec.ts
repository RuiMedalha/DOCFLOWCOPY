import { PDFDocument } from "pdf-lib";
import * as QRCode from "qrcode";
import { ExtractionService } from "../extraction.service";

/**
 * Fase 2 — deterministic AT-QR on PDFs that carry the QR as an image
 * (scans, or digital PDFs whose text layer does not include the payload).
 *
 * Builds a real PDF with a real QR (qrcode → PNG → pdf-lib) and runs
 * `decodeQrFromPdfRaster()`, i.e. pdf-parse rasterisation + the ZXing/jsQR
 * cascade. No mocks on the decoding path — if pdf-parse's screenshot or the
 * decoder regress, this test is the one that goes red.
 */
const PAYLOAD =
  "A:500000000*B:123456789*C:PT*D:FT*E:N*F:20260315*G:FT2026/1*H:J66S9FDD-1*" +
  "I1:PT*I7:100.00*I8:23.00*N:23.00*O:123.00*Q:abcd*R:1234";

async function buildPdf(opts: { qrOnPage: number; pages: number }): Promise<Buffer> {
  const png = await QRCode.toBuffer(PAYLOAD, { type: "png", scale: 6, margin: 2 });
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  for (let p = 1; p <= opts.pages; p++) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Página ${p}`, { x: 40, y: 800, size: 14 });
    if (p === opts.qrOnPage) {
      page.drawImage(img, { x: 380, y: 620, width: 170, height: 170 });
    }
  }
  return Buffer.from(await pdf.save());
}

function svcWithBuffer(buffer: Buffer): ExtractionService {
  const storage = {
    getBuffer: jest.fn(async () => ({ buffer, size: buffer.length, contentType: "application/pdf" })),
    put: jest.fn(),
    exists: jest.fn(async () => true),
    remove: jest.fn(),
  };
  return new ExtractionService({} as any, null, storage as any);
}

describe("ExtractionService.decodeQrFromPdfRaster() — Fase 2", () => {
  jest.setTimeout(240_000);

  it("decodes an AT-QR drawn as an image on page 1", async () => {
    const svc = svcWithBuffer(await buildPdf({ qrOnPage: 1, pages: 1 }));
    const out = await svc.decodeQrFromPdfRaster({ fileKey: "k", fileName: "scan.pdf" }, 1);
    expect(out).toBe(PAYLOAD);
  });

  it("falls back to the LAST page when page 1 has no QR (multi-page invoices)", async () => {
    const svc = svcWithBuffer(await buildPdf({ qrOnPage: 3, pages: 3 }));
    const out = await svc.decodeQrFromPdfRaster({ fileKey: "k", fileName: "scan.pdf" }, 3);
    expect(out).toBe(PAYLOAD);
  });

  it("returns null when no page carries a QR", async () => {
    const svc = svcWithBuffer(await buildPdf({ qrOnPage: 99, pages: 2 }));
    const out = await svc.decodeQrFromPdfRaster({ fileKey: "k", fileName: "plain.pdf" }, 2);
    expect(out).toBeNull();
  });
});
