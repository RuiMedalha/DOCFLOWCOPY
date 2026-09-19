/**
 * Fase 4.1 (P1.4) — fotos: endireitar pelo conteúdo e comprimir.
 *
 * As fotos ficavam guardadas como JPEG de 2,5–3 MB e tortas. O arquivo
 * fiscal é de 10 anos: 3 MB por documento não é sustentável, e uma
 * fatura deitada não se lê.
 *
 * A rotação por EXIF já existia e já era persistida — o que faltava era
 * o caso de a foto **não trazer** a etiqueta EXIF (ou trazê-la errada),
 * que é exactamente o das fotos que apareceram deitadas. Este módulo
 * decide a rotação a partir dos pixels:
 *
 *   1. Eixo do texto — linhas de texto criam bandas horizontais. Num
 *      documento direito a variação do perfil de tinta por LINHA é
 *      muito maior do que por COLUNA; deitado é ao contrário.
 *   2. Sentido (90 vs 270) — um documento tem margem esquerda firme e
 *      margem direita irregular, por isso a massa de tinta cai para a
 *      esquerda. Rodamos para o sentido que deixa o centróide da tinta
 *      na metade esquerda.
 *
 * Quando existe um QR-AT descodificado, a rotação que o fez ler é a
 * resposta certa e passa à frente desta heurística (ver `preferred`).
 *
 * Tudo aqui é puro: recebe e devolve matrizes de cinzentos, sem jimp,
 * sem ficheiros, sem rede — para poder ser testado a sério.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface GrayImage {
  width: number;
  height: number;
  /** Luminância 0–255, linha a linha (length = width * height). */
  data: Uint8Array | number[];
}

export interface OrientationDecision {
  rotate: Rotation;
  reason: string;
  /** 0–1: quão separados ficaram os dois eixos. Baixo = pouca certeza. */
  confidence: number;
}

/** Acima deste valor um pixel conta como fundo (papel branco). */
const INK_THRESHOLD = 160;

/** Perfil de tinta por linha e por coluna, normalizado 0–1. */
export function inkProfiles(img: GrayImage): { rows: number[]; cols: number[] } {
  const { width: w, height: h, data } = img;
  const rows = new Array<number>(h).fill(0);
  const cols = new Array<number>(w).fill(0);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x] < INK_THRESHOLD) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  return {
    rows: rows.map((v) => v / Math.max(1, w)),
    cols: cols.map((v) => v / Math.max(1, h)),
  };
}

/** Variância de um perfil — mede quão "às bandas" ele é. */
export function profileVariance(profile: number[]): number {
  if (profile.length === 0) return 0;
  const mean = profile.reduce((a, b) => a + b, 0) / profile.length;
  return profile.reduce((acc, v) => acc + (v - mean) ** 2, 0) / profile.length;
}

/**
 * Centróide horizontal da tinta, 0 (tudo à esquerda) a 1 (tudo à
 * direita). Um documento de texto latino fica abaixo de 0,5.
 */
export function inkCentroidX(img: GrayImage): number {
  const { width: w, height: h, data } = img;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x] < INK_THRESHOLD) {
        sum += x;
        count += 1;
      }
    }
  }
  if (count === 0) return 0.5;
  return sum / count / Math.max(1, w - 1);
}

/** Roda uma matriz de cinzentos 90° no sentido dos ponteiros do relógio. */
export function rotateGray90(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (x, y) → (h - 1 - y, x) numa imagem h×w
      out[x * h + (h - 1 - y)] = data[y * w + x];
    }
  }
  return { width: h, height: w, data: out };
}

/**
 * Decide a rotação necessária para pôr o documento direito.
 *
 * `preferred` é a rotação que fez o QR-AT ler, quando houve uma: é
 * prova, não heurística, e ganha sempre.
 */
export function detectOrientation(
  img: GrayImage,
  preferred?: Rotation | null,
): OrientationDecision {
  if (preferred != null) {
    return {
      rotate: preferred,
      reason: `qr_decoded_at_${preferred}deg`,
      confidence: 1,
    };
  }
  if (img.width < 8 || img.height < 8) {
    return { rotate: 0, reason: 'image_too_small', confidence: 0 };
  }

  // Faturas e recibos são documentos verticais (portrait).
  // Se a imagem já é vertical (height > width * 1.15), mantemos na vertical (rotate: 0).
  // Rodar 90° deitaria a página para paisagem, o que é quase sempre um erro.
  if (img.height > img.width * 1.15) {
    return {
      rotate: 0,
      reason: `already_portrait:${img.width}x${img.height}`,
      confidence: 0.95,
    };
  }

  // Se a imagem foi capturada na horizontal (width > height * 1.15), rodar 90° para portrait.
  if (img.width > img.height * 1.15) {
    return {
      rotate: 90,
      reason: `landscape_to_portrait:${img.width}x${img.height}`,
      confidence: 0.95,
    };
  }

  const { rows, cols } = inkProfiles(img);
  const rowVar = profileVariance(rows);
  const colVar = profileVariance(cols);
  const total = rowVar + colVar;

  if (total <= 0) {
    return { rotate: 0, reason: 'no_ink_detected', confidence: 0 };
  }
  const confidence = Math.abs(rowVar - colVar) / total;

  // Bandas horizontais dominam → o texto já corre na horizontal.
  if (rowVar >= colVar) {
    return {
      rotate: 0,
      reason: `text_lines_horizontal:rowVar=${rowVar.toFixed(4)},colVar=${colVar.toFixed(4)}`,
      confidence,
    };
  }

  // O texto corre na vertical: a página está deitada. Falta o sentido.
  // Rodar 90° CW e 270° CW dá duas leituras; fica a que deixa a tinta
  // encostada à esquerda, como manda a margem de um documento.
  const cw90 = rotateGray90(img);
  const cw270 = rotateGray90(rotateGray90(rotateGray90(img)));
  const c90 = inkCentroidX(cw90);
  const c270 = inkCentroidX(cw270);
  const rotate: Rotation = c90 <= c270 ? 90 : 270;
  return {
    rotate,
    reason:
      `text_lines_vertical:rowVar=${rowVar.toFixed(4)},colVar=${colVar.toFixed(4)},` +
      `centroid90=${c90.toFixed(3)},centroid270=${c270.toFixed(3)}`,
    confidence,
  };
}

/** Limite do ficheiro de arquivo pedido pelo cliente. */
export const ARCHIVE_MAX_BYTES = 500 * 1024;

/** Lado maior máximo — acima disto o texto já não ganha legibilidade. */
export const ARCHIVE_MAX_EDGE = 2200;

/**
 * Escada de qualidade JPEG para chegar aos ≤ 500 KB. Começamos alto
 * (o QR tem de continuar legível) e só descemos enquanto for preciso.
 */
export const ARCHIVE_QUALITY_LADDER = [85, 75, 65, 55, 45] as const;

/** Dimensões depois de limitar o lado maior, mantendo a proporção. */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge = ARCHIVE_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    scaled: true,
  };
}
