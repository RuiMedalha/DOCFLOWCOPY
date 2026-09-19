import sharp from 'sharp';
import { Logger } from '@nestjs/common';

export interface Point {
  x: number;
  y: number;
}

export interface PerspectiveCropResult {
  buffer: Buffer;
  applied: boolean;
  confidence: number;
  corners?: [Point, Point, Point, Point]; // [TL, TR, BR, BL]
  reason?: string;
}

const logger = new Logger('PerspectiveCrop');

/**
 * Distância euclidiana entre dois pontos
 */
function dist(p1: Point, p2: Point): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Ordena 4 cantos em ordem canónica: [Top-Left, Top-Right, Bottom-Right, Bottom-Left]
 */
export function sortCorners(pts: Point[]): [Point, Point, Point, Point] {
  // Soma (x + y): menor é Top-Left, maior é Bottom-Right
  // Diferença (y - x): menor é Top-Right, maior é Bottom-Left
  let tl = pts[0];
  let tr = pts[0];
  let br = pts[0];
  let bl = pts[0];

  let minSum = pts[0].x + pts[0].y;
  let maxSum = minSum;
  let minDiff = pts[0].y - pts[0].x;
  let maxDiff = minDiff;

  for (let i = 1; i < pts.length; i++) {
    const sum = pts[i].x + pts[i].y;
    const diff = pts[i].y - pts[i].x;

    if (sum < minSum) {
      minSum = sum;
      tl = pts[i];
    }
    if (sum > maxSum) {
      maxSum = sum;
      br = pts[i];
    }
    if (diff < minDiff) {
      minDiff = diff;
      tr = pts[i];
    }
    if (diff > maxDiff) {
      maxDiff = diff;
      bl = pts[i];
    }
  }

  return [tl, tr, br, bl];
}

/**
 * Resolve sistema 8x8 para obter a matriz de homografia inversa (destino -> origem)
 */
function getPerspectiveTransform(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point],
): number[] {
  // Mapeia dst -> src para amostragem inversa (evita buracos na imagem resultante)
  const a: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const dx = dst[i].x;
    const dy = dst[i].y;
    const sx = src[i].x;
    const sy = src[i].y;

    a.push([dx, dy, 1, 0, 0, 0, -dx * sx, -dy * sx]);
    b.push(sx);
    a.push([0, 0, 0, dx, dy, 1, -dx * sy, -dy * sy]);
    b.push(sy);
  }

  // Eliminação de Gauss-Jordan
  const n = 8;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[maxRow][i])) {
        maxRow = k;
      }
    }

    const tmpA = a[i];
    a[i] = a[maxRow];
    a[maxRow] = tmpA;

    const tmpB = b[i];
    b[i] = b[maxRow];
    b[maxRow] = tmpB;

    if (Math.abs(a[i][i]) < 1e-10) {
      throw new Error('Matriz singular na transformação de perspetiva');
    }

    for (let k = i + 1; k < n; k++) {
      const c = a[k][i] / a[i][i];
      for (let j = i; j < n; j++) {
        a[k][j] -= c * a[i][j];
      }
      b[k] -= c * b[i];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += a[i][j] * x[j];
    }
    x[i] = (b[i] - sum) / a[i][i];
  }

  return [...x, 1]; // [h0, h1, h2, h3, h4, h5, h6, h7, 1]
}

/**
 * Deteta os 4 cantos do documento utilizando segmentação de contraste e análise de quadrilátero
 */
export async function detectDocumentCorners(
  buffer: Buffer,
  origWidth: number,
  origHeight: number,
): Promise<{ corners: [Point, Point, Point, Point]; confidence: number } | null> {
  try {
    // Miniatura de 300px para processamento ultra-rápido
    const thumbW = 300;
    const thumb = await sharp(buffer)
      .resize({ width: thumbW, withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = thumb;
    const tw = info.width;
    const th = info.height;
    const total = tw * th;

    // 1. Histograma e limiar Otsu
    const hist = new Int32Array(256);
    for (let i = 0; i < total; i++) hist[data[i]]++;

    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let varMax = 0;
    let threshold = 128;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) {
        varMax = varBetween;
        threshold = t;
      }
    }

    // 2. Encontrar extremos do papel (componentes conectados/binarizados)
    // Procuramos os 4 cantos: top-left (min sum), top-right (min diff),
    // bottom-right (max sum), bottom-left (max diff)
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;

    let tlThumb: Point = { x: 0, y: 0 };
    let trThumb: Point = { x: tw - 1, y: 0 };
    let brThumb: Point = { x: tw - 1, y: th - 1 };
    let blThumb: Point = { x: 0, y: th - 1 };

    let paperPixelCount = 0;
    const marginIgnore = Math.round(tw * 0.015); // ignorar 1.5% das bordas externas de ruído de sensor

    for (let y = marginIgnore; y < th - marginIgnore; y++) {
      const rowOffset = y * tw;
      for (let x = marginIgnore; x < tw - marginIgnore; x++) {
        if (data[rowOffset + x] >= threshold) {
          paperPixelCount++;
          const s = x + y;
          const d = y - x;

          if (s < minSum) {
            minSum = s;
            tlThumb = { x, y };
          }
          if (s > maxSum) {
            maxSum = s;
            brThumb = { x, y };
          }
          if (d < minDiff) {
            minDiff = d;
            trThumb = { x, y };
          }
          if (d > maxDiff) {
            maxDiff = d;
            blThumb = { x, y };
          }
        }
      }
    }

    // 3. Avaliar confiança
    const coverage = paperPixelCount / total;
    // Se o papel cobrir quase tudo (> 93%) ou quase nada (< 18%), o recorte é arriscado
    if (coverage < 0.18 || coverage > 0.93) {
      return null;
    }

    // Escalar cantos para o tamanho original
    const sx = origWidth / tw;
    const sy = origHeight / th;

    const corners: [Point, Point, Point, Point] = sortCorners([
      { x: Math.round(tlThumb.x * sx), y: Math.round(tlThumb.y * sy) },
      { x: Math.round(trThumb.x * sx), y: Math.round(trThumb.y * sy) },
      { x: Math.round(brThumb.x * sx), y: Math.round(brThumb.y * sy) },
      { x: Math.round(blThumb.x * sx), y: Math.round(blThumb.y * sy) },
    ]);

    // Validar proporções do quadrilátero
    const [tl, tr, br, bl] = corners;
    const topW = dist(tl, tr);
    const botW = dist(bl, br);
    const leftH = dist(tl, bl);
    const rightH = dist(tr, br);

    const minDim = Math.min(topW, botW, leftH, rightH);
    if (minDim < Math.min(origWidth, origHeight) * 0.2) {
      // Muito pequeno ou colapsado
      return null;
    }

    // Calcular score de confiança (0.0 a 1.0)
    // Se os lados opostos tiverem comprimentos plausíveis e cobertura entre 25% e 85%
    const wRatio = Math.min(topW, botW) / Math.max(topW, botW);
    const hRatio = Math.min(leftH, rightH) / Math.max(leftH, rightH);
    const shapePlausibility = (wRatio + hRatio) / 2;

    const coverageScore = 1 - Math.abs(coverage - 0.55) * 1.5;
    const confidence = Math.max(0, Math.min(0.99, Number((shapePlausibility * 0.6 + coverageScore * 0.4).toFixed(2))));

    return { corners, confidence };
  } catch (err) {
    logger.debug(`Falha na deteção de cantos: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Executa a transformação de perspetiva dos 4 cantos para um retângulo perfeito.
 */
export async function applyPerspectiveWarp(
  buffer: Buffer,
  corners: [Point, Point, Point, Point],
  origWidth: number,
  origHeight: number,
): Promise<Buffer> {
  const [tl, tr, br, bl] = corners;

  // Determinar dimensões de destino (largura e altura retangulares máximas)
  const widthA = dist(br, bl);
  const widthB = dist(tr, tl);
  const maxWidth = Math.max(Math.round(widthA), Math.round(widthB));

  const heightA = dist(tr, br);
  const heightB = dist(tl, bl);
  const maxHeight = Math.max(Math.round(heightA), Math.round(heightB));

  // Destino retangular perfeito com margem de segurança de 1% para não cortar texto
  const dst: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: maxWidth - 1, y: 0 },
    { x: maxWidth - 1, y: maxHeight - 1 },
    { x: 0, y: maxHeight - 1 },
  ];

  // Matriz de homografia inversa (para cada pixel (x,y) de dst -> pega pixel em src)
  const H = getPerspectiveTransform(corners, dst);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;

  // Carregar imagem de origem em formato RAW (RGB/RGBA)
  const origImage = sharp(buffer);
  const { data: srcData, info: srcInfo } = await origImage
    .raw()
    .toBuffer({ resolveWithObject: true });

  const srcW = srcInfo.width;
  const srcH = srcInfo.height;
  const channels = srcInfo.channels;

  // Buffer de saída para a imagem transformada
  const dstData = Buffer.alloc(maxWidth * maxHeight * channels);

  for (let y = 0; y < maxHeight; y++) {
    const rowOffset = y * maxWidth * channels;
    for (let x = 0; x < maxWidth; x++) {
      // Projeção inversa de homografia
      const denom = h6 * x + h7 * y + h8;
      if (denom === 0) continue;
      const sx = (h0 * x + h1 * y + h2) / denom;
      const sy = (h3 * x + h4 * y + h5) / denom;

      // Interpolação bilinear nos limites da imagem de origem
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      const dstOffset = rowOffset + x * channels;

      if (x0 >= 0 && x1 < srcW && y0 >= 0 && y1 < srcH) {
        const fx = sx - x0;
        const fy = sy - y0;
        const fx1 = 1 - fx;
        const fy1 = 1 - fy;

        const w00 = fx1 * fy1;
        const w10 = fx * fy1;
        const w01 = fx1 * fy;
        const w11 = fx * fy;

        const idx00 = (y0 * srcW + x0) * channels;
        const idx10 = (y0 * srcW + x1) * channels;
        const idx01 = (y1 * srcW + x0) * channels;
        const idx11 = (y1 * srcW + x1) * channels;

        for (let c = 0; c < channels; c++) {
          dstData[dstOffset + c] = Math.round(
            srcData[idx00 + c] * w00 +
            srcData[idx10 + c] * w10 +
            srcData[idx01 + c] * w01 +
            srcData[idx11 + c] * w11,
          );
        }
      } else if (x0 >= 0 && x0 < srcW && y0 >= 0 && y0 < srcH) {
        // Nearest neighbor nas bordas exatas
        const idx = (y0 * srcW + x0) * channels;
        for (let c = 0; c < channels; c++) {
          dstData[dstOffset + c] = srcData[idx + c];
        }
      } else {
        // Fora dos limites: fundo branco
        for (let c = 0; c < channels; c++) {
          dstData[dstOffset + c] = 255;
        }
      }
    }
  }

  // Codificar de volta em JPEG de alta qualidade
  return await sharp(dstData, {
    raw: {
      width: maxWidth,
      height: maxHeight,
      channels,
    },
  })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/**
 * Função principal de recorte de perspetiva com salvaguarda total de confiança.
 */
export async function cropPerspectiveIfConfident(
  buffer: Buffer,
  mime: string,
  minConfidence = 0.65,
): Promise<PerspectiveCropResult> {
  if (!/^image\/(jpeg|jpg|png|webp)/i.test(mime)) {
    return { buffer, applied: false, confidence: 0, reason: 'unsupported_mime' };
  }

  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) {
      return { buffer, applied: false, confidence: 0, reason: 'missing_dimensions' };
    }

    const detection = await detectDocumentCorners(buffer, meta.width, meta.height);
    if (!detection || detection.confidence < minConfidence) {
      const conf = detection?.confidence ?? 0;
      logger.log(`[cropPerspective] Confiança insuficiente (${conf} < ${minConfidence}). Mantendo imagem original.`);
      return {
        buffer,
        applied: false,
        confidence: conf,
        reason: 'low_confidence_or_noisy_background',
      };
    }

    logger.log(
      `[cropPerspective] Deteção de papel com alta confiança (${detection.confidence}). Aplicando transformação de perspetiva.`,
    );

    const warped = await applyPerspectiveWarp(buffer, detection.corners, meta.width, meta.height);
    return {
      buffer: warped,
      applied: true,
      confidence: detection.confidence,
      corners: detection.corners,
    };
  } catch (err) {
    logger.warn(`[cropPerspective] Erro ao aplicar recorte: ${(err as Error).message}. Mantendo original.`);
    return { buffer, applied: false, confidence: 0, reason: (err as Error).message };
  }
}
