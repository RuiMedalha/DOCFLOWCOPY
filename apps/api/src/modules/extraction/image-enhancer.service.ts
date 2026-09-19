import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

export interface ImageEnhanceOptions {
  autoRotate?: boolean;
  normalizeContrast?: boolean;
  sharpen?: boolean;
  binarize?: boolean;
  threshold?: number;
}

export interface ProcessDocumentImageOptions {
  autoRotate?: boolean;
  forcePortrait?: boolean;
  trim?: boolean;
  normalizeContrast?: boolean;
  sharpen?: boolean;
  quality?: number;
  maxDimension?: number;
}

export interface VisionPreparationResult {
  buffer: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  originalBytes: number;
  optimizedBytes: number;
}

/**
 * ImageEnhancerService — motor de alta velocidade sobre libvips (C/C++).
 *
 * Inspirado nas técnicas do ImageToolbox e Parsr:
 *   1. Auto-rotação física via metadados EXIF da câmara.
 *   2. Resgate de talões térmicos (combustível, restauração) com tinta fraca.
 *   3. Equalização de histograma e binarização adaptativa para OCR.
 *   4. Otimização de payload para Visão IA (Gemini/OpenAI) mantendo 100% de legibilidade.
 */
@Injectable()
export class ImageEnhancerService {
  private readonly logger = new Logger(ImageEnhancerService.name);

  /**
   * Verifica se o motor sharp / libvips está operacional no runtime.
   */
  isAvailable(): boolean {
    try {
      return typeof sharp === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Pipeline completo de preparação de imagem de documento / fatura (telemóvel ou scanner):
   * 1. Auto-orienta com base nos metadados EXIF da câmara.
   * 2. Recorta (crop/trim) margens de mesa ou superfícies em volta do papel (algoritmo Otsu em miniatura).
   * 3. Detecta se a imagem/documento ficou na horizontal (landscape) e roda 90° para vertical (portrait).
   * 4. Redimensiona fotos gigantes (max 2400px) para otimizar memória e nitidez.
   * 5. Estica e equaliza o contraste (histogram normalization) para fundo branco e texto preto.
   * 6. Aplica filtro de nitidez (unsharp mask) para caracteres, números e linhas de tabela.
   * 7. Codifica em JPEG de alta qualidade com mozjpeg.
   */
  async processDocumentImage(
    buffer: Buffer,
    mime: string,
    options: ProcessDocumentImageOptions = {},
  ): Promise<Buffer> {
    const {
      autoRotate = true,
      forcePortrait = true,
      trim = true,
      normalizeContrast = true,
      sharpen: shouldSharpen = true,
      quality = 88,
      maxDimension = 2400,
    } = options;

    try {
      let pipeline = sharp(buffer);

      // 1. Auto-rotação física via EXIF
      if (autoRotate) {
        pipeline = pipeline.rotate();
      }

      let intermediate = await pipeline.toBuffer();
      let meta = await sharp(intermediate).metadata();

      // 2. Deteção inteligente de limites de papel e recorte (trim de mesa / fundo de suporte)
      if (trim && meta.width && meta.height) {
        const cropBounds = await this.detectPaperCropBounds(intermediate, meta.width, meta.height);
        if (cropBounds) {
          this.logger.log(
            `[processDocumentImage] Borda de suporte detetada — recortando papel: left=${cropBounds.left}, top=${cropBounds.top}, ${cropBounds.width}x${cropBounds.height} (orig ${meta.width}x${meta.height})`,
          );
          try {
            intermediate = await sharp(intermediate).extract(cropBounds).toBuffer();
            meta = await sharp(intermediate).metadata();
          } catch (extractErr) {
            this.logger.warn(`[processDocumentImage] Falha ao recortar: ${(extractErr as Error).message}`);
          }
        }
      }

      // 3. Se a foto / papel recortado ficou em modo Paisagem (Landscape) onde largura > altura * 1.05,
      // rodar 90° para ficar em sentido vertical (portrait).
      if (forcePortrait && meta.width && meta.height && meta.width > meta.height * 1.05) {
        this.logger.log(
          `[processDocumentImage] Imagem/documento na horizontal (${meta.width}x${meta.height}) — a rodar 90° para sentido vertical (portrait)`,
        );
        intermediate = await sharp(intermediate).rotate(90).toBuffer();
        meta = await sharp(intermediate).metadata();
      }

      let finalPipeline = sharp(intermediate);

      // 4. Redimensionar se exceder dimensão máxima
      const curW = meta.width || 2000;
      const curH = meta.height || 2000;
      if (curW > maxDimension || curH > maxDimension) {
        finalPipeline = finalPipeline.resize({
          width: curW >= curH ? maxDimension : undefined,
          height: curH > curW ? maxDimension : undefined,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      // 5. Normalizar contraste para fundo branco e texto preto legível
      if (normalizeContrast) {
        finalPipeline = finalPipeline.normalize();
      }

      // 6. Nitidez para caracteres e números
      if (shouldSharpen) {
        finalPipeline = finalPipeline.sharpen({ sigma: 1.2, m1: 0.8, m2: 2.0 });
      }

      const resultBuffer = await finalPipeline
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      this.logger.log(
        `[processDocumentImage] Concluído com sucesso: ${buffer.length}B → ${resultBuffer.length}B (${meta.width}x${meta.height})`,
      );
      return resultBuffer;
    } catch (err) {
      this.logger.warn(
        `[processDocumentImage] Falha no processamento sharp: ${(err as Error).message}. Retornando original.`,
      );
      return buffer;
    }
  }

  /**
   * Deteta os limites do papel do documento sobre a mesa/superfície e calcula o retângulo de recorte.
   * Utiliza binarização rápida de Otsu sobre uma miniatura de 300px em escala de cinzentos.
   */
  async detectPaperCropBounds(
    buffer: Buffer,
    origW: number,
    origH: number,
  ): Promise<{ left: number; top: number; width: number; height: number } | null> {
    try {
      const thumb = await sharp(buffer)
        .resize({ width: 300, withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { data, info } = thumb;
      const tw = info.width;
      const th = info.height;

      // Histograma de luminância
      const hist = new Int32Array(256);
      for (let i = 0; i < data.length; i++) hist[data[i]]++;

      const total = data.length;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];

      let sumB = 0;
      let wB = 0;
      let varMax = 0;
      let threshold = 128;

      // Limiar ótimo de Otsu
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > varMax) {
          varMax = varBetween;
          threshold = t;
        }
      }

      // Procura limites dos pixels correspondentes ao papel claro
      let minX = tw;
      let maxX = 0;
      let minY = th;
      let maxY = 0;
      let paperPixels = 0;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          if (data[y * tw + x] >= threshold) {
            paperPixels++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const paperCoverage = paperPixels / total;
      // Recortar apenas se o papel ocupar entre 15% e 94% da imagem (há fundo/mesa em redor)
      if (paperCoverage < 0.15 || paperCoverage > 0.94) {
        return null;
      }

      const boxW = maxX - minX;
      const boxH = maxY - minY;
      if (boxW < tw * 0.25 || boxH < th * 0.25) {
        return null;
      }

      // Margem de segurança de 2% para evitar cortar texto nas margens do papel
      const padX = Math.round(tw * 0.02);
      const padY = Math.round(th * 0.02);
      const safeMinX = Math.max(0, minX - padX);
      const safeMinY = Math.max(0, minY - padY);
      const safeMaxX = Math.min(tw, maxX + padX);
      const safeMaxY = Math.min(th, maxY + padY);

      const scaleX = origW / tw;
      const scaleY = origH / th;

      return {
        left: Math.round(safeMinX * scaleX),
        top: Math.round(safeMinY * scaleY),
        width: Math.round((safeMaxX - safeMinX) * scaleX),
        height: Math.round((safeMaxY - safeMinY) * scaleY),
      };
    } catch {
      return null;
    }
  }

  /**
   * Normaliza a orientação física da imagem com base nos metadados EXIF.
   */
  async autoRotate(buffer: Buffer): Promise<Buffer> {
    try {
      return await sharp(buffer).rotate().toBuffer();
    } catch (err) {
      this.logger.warn(`Falha na auto-rotação da imagem: ${(err as Error).message}`);
      return buffer;
    }
  }

  /**
   * Resgata talões térmicos apagados ou desbotados (papel amarelado/cinzento, tinta fraca).
   * Aplica esticamento de níveis, amplificação de contraste e filtro de arestas de texto.
   */
  async rescueThermalReceipt(buffer: Buffer): Promise<Buffer> {
    try {
      return await sharp(buffer)
        .rotate()
        .grayscale()
        .toColourspace('b-w')
        .normalize()
        .linear(1.3, -15) // Amplifica o contraste do texto contra o papel térmico
        .sharpen({ sigma: 1.8, m1: 0.8, m2: 2.5 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(`Falha no resgate térmico: ${(err as Error).message}`);
      return buffer;
    }
  }

  /**
   * Pré-processamento geral para OCR e leitura de QR Codes difíceis.
   */
  async enhanceForOcr(buffer: Buffer, options: ImageEnhanceOptions = {}): Promise<Buffer> {
    const {
      autoRotate = true,
      normalizeContrast = true,
      sharpen: shouldSharpen = true,
      binarize = false,
      threshold = 128,
    } = options;

    try {
      let pipeline = sharp(buffer);

      if (autoRotate) {
        pipeline = pipeline.rotate();
      }

      pipeline = pipeline.grayscale().toColourspace('b-w');

      if (normalizeContrast) {
        pipeline = pipeline.normalize();
      }

      if (shouldSharpen) {
        pipeline = pipeline.sharpen({ sigma: 1.4, m1: 0.5, m2: 2.0 });
      }

      if (binarize) {
        pipeline = pipeline.threshold(threshold);
      }

      return await pipeline.toBuffer();
    } catch (err) {
      this.logger.warn(`Falha no pré-processamento de OCR: ${(err as Error).message}`);
      return buffer;
    }
  }

  /**
   * Prepara imagens para envio à Visão IA (Gemini / OpenAI / OpenRouter).
   * Redimensiona documentos com dimensões gigantescas (ex: 48MP de telemóvel)
   * para uma densidade ótima de leitura (max 2048px), poupando quotas e memória.
   */
  async prepareForVisionAi(
    buffer: Buffer,
    maxDimension = 2048,
  ): Promise<VisionPreparationResult> {
    const originalBytes = buffer.length;
    try {
      const metadata = await sharp(buffer).metadata();
      const currentWidth = metadata.width || 2048;
      const currentHeight = metadata.height || 2048;

      let pipeline = sharp(buffer).rotate();

      if (currentWidth > maxDimension || currentHeight > maxDimension) {
        pipeline = pipeline.resize({
          width: currentWidth >= currentHeight ? maxDimension : undefined,
          height: currentHeight > currentWidth ? maxDimension : undefined,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      // Normaliza contraste suavemente para facilitar leitura da IA sem estragar layout
      const optimizedBuffer = await pipeline
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();

      const outMeta = await sharp(optimizedBuffer).metadata();

      return {
        buffer: optimizedBuffer,
        mimeType: 'image/jpeg',
        width: outMeta.width || currentWidth,
        height: outMeta.height || currentHeight,
        originalBytes,
        optimizedBytes: optimizedBuffer.length,
      };
    } catch (err) {
      this.logger.warn(`Falha ao otimizar imagem para IA: ${(err as Error).message}`);
      return {
        buffer,
        mimeType: 'image/jpeg',
        width: 0,
        height: 0,
        originalBytes,
        optimizedBytes: originalBytes,
      };
    }
  }

  /**
   * Obtém metadados visuais rápidos (largura, altura, formato, rotação EXIF).
   */
  async getMetadata(buffer: Buffer): Promise<sharp.Metadata | null> {
    try {
      return await sharp(buffer).metadata();
    } catch {
      return null;
    }
  }
}
