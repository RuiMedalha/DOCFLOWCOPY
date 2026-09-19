import { Injectable, Logger } from '@nestjs/common';
import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_QUALITY_LADDER,
  detectOrientation,
  fitWithinMaxEdge,
  type GrayImage,
  type Rotation,
} from './archive-image';

export interface ArchiveImageResult {
  /** JPEG endireitado e comprimido, pronto a embeber no PDF de arquivo. */
  buffer: Buffer;
  rotation: Rotation;
  rotationReason: string;
  quality: number;
  width: number;
  height: number;
  originalBytes: number;
  /** True quando ficou dentro dos 500 KB pedidos. */
  withinBudget: boolean;
}

/**
 * Fase 4.1 (P1.4) — prepara a imagem para o arquivo fiscal.
 *
 * Endireita pelo conteúdo (não só pelo EXIF, que muitas fotos não
 * trazem) e comprime para ≤ 500 KB mantendo o texto legível. O original
 * fica no MinIO; é o PDF que vai para arquivo e para o TOC.
 *
 * Usa jimp (JS puro, sem dependências nativas — o `sharp` não instala de
 * forma fiável neste monorepo em Windows). Toda a decisão de rotação
 * vive em `archive-image.ts`, que é puro e testado; aqui só se mexe em
 * pixels e bytes.
 */
@Injectable()
export class ArchiveImageService {
  private readonly logger = new Logger(ArchiveImageService.name);

  /**
   * @param preferredRotation rotação que fez o QR-AT ler, quando houve
   *        uma. É prova e ganha à heurística de projeção.
   */
  async prepare(
    buffer: Buffer,
    mime: string,
    preferredRotation?: Rotation | null,
  ): Promise<ArchiveImageResult | null> {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mime)) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Jimp } = require('jimp') as {
        Jimp: { read: (b: Buffer) => Promise<JimpImage> };
      };
      // Jimp.read aplica a rotação EXIF sozinho — partimos daí.
      let img = await Jimp.read(buffer);

      const decision = detectOrientation(this.toGray(img), preferredRotation ?? null);
      if (decision.rotate !== 0) {
        img = img.rotate({ deg: decision.rotate } as unknown as number);
        this.logger.log(
          `[archive] rotating ${decision.rotate}° — ${decision.reason}`,
        );
      }

      const fit = fitWithinMaxEdge(img.bitmap.width, img.bitmap.height);
      if (fit.scaled) {
        img = img.resize({ w: fit.width, h: fit.height } as unknown as number);
      }

      // Escada de qualidade: paramos no primeiro que cabe no orçamento.
      let out: Buffer | null = null;
      let quality: number = ARCHIVE_QUALITY_LADDER[0];
      for (const q of ARCHIVE_QUALITY_LADDER) {
        quality = q;
        out = Buffer.from(await img.getBuffer('image/jpeg', { quality: q }));
        if (out.length <= ARCHIVE_MAX_BYTES) break;
      }
      if (!out) return null;

      // Uma foto que já era pequena e já estava direita não tem nada a
      // ganhar em ser re-codificada: só perderia qualidade e, com o
      // invólucro do PDF, ainda acabava maior (262KB → 348KB no teste
      // real). Nesse caso ficamos com os bytes originais.
      if (
        decision.rotate === 0 &&
        !fit.scaled &&
        buffer.length <= ARCHIVE_MAX_BYTES &&
        out.length >= buffer.length
      ) {
        return {
          buffer,
          rotation: 0,
          rotationReason: `${decision.reason};kept_original_already_small`,
          quality: 100,
          width: img.bitmap.width,
          height: img.bitmap.height,
          originalBytes: buffer.length,
          withinBudget: true,
        };
      }

      return {
        buffer: out,
        rotation: decision.rotate,
        rotationReason: decision.reason,
        quality,
        width: img.bitmap.width,
        height: img.bitmap.height,
        originalBytes: buffer.length,
        withinBudget: out.length <= ARCHIVE_MAX_BYTES,
      };
    } catch (err) {
      // Nunca bloqueia o upload: sem derivado de arquivo, o original
      // continua guardado e legível.
      this.logger.warn(`[archive] prepare failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Luminância da imagem, reduzida para a análise de orientação ser barata. */
  private toGray(img: JimpImage): GrayImage {
    const MAX = 900;
    const { width, height } = img.bitmap;
    const step = Math.max(1, Math.ceil(Math.max(width, height) / MAX));
    const w = Math.max(1, Math.floor(width / step));
    const h = Math.max(1, Math.floor(height / step));
    const data = new Uint8Array(w * h);
    const src = img.bitmap.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(width - 1, x * step);
        const sy = Math.min(height - 1, y * step);
        const i = (sy * width + sx) * 4;
        // Luma ITU-R BT.601.
        data[y * w + x] = (src[i] * 299 + src[i + 1] * 587 + src[i + 2] * 114) / 1000;
      }
    }
    return { width: w, height: h, data };
  }
}

interface JimpImage {
  bitmap: { width: number; height: number; data: Buffer };
  rotate: (deg: number) => JimpImage;
  resize: (opts: number) => JimpImage;
  getBuffer: (mime: string, opts?: { quality?: number }) => Promise<Buffer | Uint8Array>;
}
