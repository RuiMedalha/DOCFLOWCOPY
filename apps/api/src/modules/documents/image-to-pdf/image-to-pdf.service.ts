import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

/**
 * Image → single-page PDF converter.
 *
 * Wraps the original photo bytes inside a one-page PDF sized to fit the
 * image at its native aspect ratio. The PDF is meant as a *viewable*
 * derivative for the UI / download route — the original photo stays on
 * disk for re-OCR / re-classification.
 *
 * Why pdf-lib: pure JS, zero native deps, embeds JPG / PNG natively via
 * `embedJpg` / `embedPng`. HEIC is intentionally NOT supported here —
 * mobile upload pipelines should transcode HEIC → JPEG before reaching
 * the upload endpoint (see HEIC conversion note in the upload service).
 *
 * Failure policy: any throw bubbles up to the caller, which logs and
 * continues the upload with the image only. We never block the user
 * because the PDF derivative failed.
 */
@Injectable()
export class ImageToPdfService {
  private readonly logger = new Logger(ImageToPdfService.name);

  /** Default page size when we can't sniff the image dimensions (PNG only — pdf-lib returns sizes for JPG/PNG). */
  private static readonly FALLBACK_PAGE_WIDTH = 595.28; // A4 in points
  private static readonly FALLBACK_PAGE_HEIGHT = 841.89;

  /**
   * Convert image bytes (JPG/PNG) into a single-page PDF embedding them
   * at their native pixel size (1 px == 1 pt by default). The caller is
   * expected to pass a mime that's one of `image/jpeg`, `image/jpg`,
   * `image/png` — anything else throws.
   */
  async convert(buffer: Buffer, mime: string): Promise<Buffer> {
    const normalized = mime.toLowerCase();
    const pdf = await PDFDocument.create();
    pdf.setTitle('DocFlow — uploaded document');
    pdf.setProducer('docflow/image-to-pdf');
    pdf.setCreator('DocFlow');

    let embedded;
    let widthPx = 0;
    let heightPx = 0;

    if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
      embedded = await pdf.embedJpg(buffer);
      widthPx = embedded.width;
      heightPx = embedded.height;
    } else if (normalized === 'image/png') {
      embedded = await pdf.embedPng(buffer);
      widthPx = embedded.width;
      heightPx = embedded.height;
    } else {
      throw new Error(`Unsupported image MIME for PDF conversion: ${mime}`);
    }

    // Página padrão A4 vertical (595.28 × 841.89 pt) para arquivo fiscal oficial (art. 52.º CIVA).
    const A4_WIDTH = ImageToPdfService.FALLBACK_PAGE_WIDTH;
    const A4_HEIGHT = ImageToPdfService.FALLBACK_PAGE_HEIGHT;
    const margin = 20;
    const maxW = A4_WIDTH - margin * 2;
    const maxH = A4_HEIGHT - margin * 2;

    const scale = Math.min(maxW / widthPx, maxH / heightPx, 1);
    const renderW = widthPx * scale;
    const renderH = heightPx * scale;

    const page = pdf.addPage([A4_WIDTH, A4_HEIGHT]);

    const x = Math.round((A4_WIDTH - renderW) / 2);
    const y = Math.round((A4_HEIGHT - renderH) / 2);

    page.drawImage(embedded, {
      x,
      y,
      width: renderW,
      height: renderH,
    });

    const bytes = await pdf.save();
    this.logger.log(
      `image-to-pdf: in=${buffer.length}B out=${bytes.length}B mime=${normalized} A4 portrait (${renderW.toFixed(0)}x${renderH.toFixed(0)})`,
    );
    return Buffer.from(bytes);
  }

  /** True when this mime should produce a PDF derivative. */
  supports(mime: string): boolean {
    const m = mime.toLowerCase();
    return m === 'image/jpeg' || m === 'image/jpg' || m === 'image/png';
  }
}
