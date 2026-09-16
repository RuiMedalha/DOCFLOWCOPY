import {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_EDGE,
  detectOrientation,
  fitWithinMaxEdge,
  inkCentroidX,
  inkProfiles,
  profileVariance,
  rotateGray90,
  type GrayImage,
} from '../archive-image';

/**
 * Fase 4.1 (P1.4) — "as imagens atuais aparecem deitadas". A rotação por
 * EXIF já existia e já era persistida; o que faltava era o caso de a
 * foto não trazer a etiqueta EXIF. Estes testes cobrem a decisão feita
 * a partir dos pixels.
 */

/** Página branca com linhas de texto horizontais e margem esquerda. */
function makeDocument(width = 120, height = 160): GrayImage {
  const data = new Uint8Array(width * height).fill(255);
  const leftMargin = Math.round(width * 0.12);
  for (let line = 0; line < 12; line++) {
    const y0 = 10 + line * 12;
    // Linhas com comprimento irregular à direita (texto ao baixo).
    const lineWidth = Math.round(width * (0.55 + ((line * 7) % 30) / 100));
    for (let y = y0; y < y0 + 4 && y < height; y++) {
      for (let x = leftMargin; x < leftMargin + lineWidth && x < width; x++) {
        data[y * width + x] = 20;
      }
    }
  }
  return { width, height, data };
}

describe('detectOrientation()', () => {
  it('deixa em paz um documento já direito', () => {
    const out = detectOrientation(makeDocument());
    expect(out.rotate).toBe(0);
    expect(out.reason).toMatch(/already_portrait|text_lines_horizontal/);
  });

  it('endireita uma foto deitada mesmo sem etiqueta EXIF', () => {
    // Uma foto tirada com o telemóvel de lado: o documento aparece
    // rodado 90° no sentido contrário aos ponteiros.
    const sideways = rotateGray90(makeDocument());
    const out = detectOrientation(sideways);
    expect(out.rotate).not.toBe(0);
    expect([90, 270]).toContain(out.rotate);
    expect(out.reason).toMatch(/landscape_to_portrait|text_lines_vertical/);
  });

  it('escolhe o sentido que repõe as linhas na horizontal', () => {
    const original = makeDocument();
    const sideways = rotateGray90(original);
    const { rotate } = detectOrientation(sideways);
    let fixed: GrayImage = sideways;
    for (let i = 0; i < rotate / 90; i++) fixed = rotateGray90(fixed);
    const p = inkProfiles(fixed);
    // Depois de corrigida, a variação por linha volta a dominar.
    expect(profileVariance(p.rows)).toBeGreaterThan(profileVariance(p.cols));
  });

  it('um QR descodificado é prova e passa à frente da heurística', () => {
    const out = detectOrientation(makeDocument(), 270);
    expect(out.rotate).toBe(270);
    expect(out.confidence).toBe(1);
    expect(out.reason).toBe('qr_decoded_at_270deg');
  });

  it('não inventa uma rotação numa imagem em branco ou minúscula', () => {
    const blank: GrayImage = { width: 50, height: 50, data: new Uint8Array(2500).fill(255) };
    expect(detectOrientation(blank)).toMatchObject({ rotate: 0, confidence: 0 });
    const tiny: GrayImage = { width: 4, height: 4, data: new Uint8Array(16) };
    expect(detectOrientation(tiny)).toMatchObject({ rotate: 0, reason: 'image_too_small' });
  });
});

describe('rotateGray90()', () => {
  it('roda 90° no sentido dos ponteiros e troca as dimensões', () => {
    // 2×3 →  3×2
    const img: GrayImage = { width: 2, height: 3, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    const out = rotateGray90(img);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect(Array.from(out.data)).toEqual([5, 3, 1, 6, 4, 2]);
  });

  it('quatro rotações devolvem a imagem original', () => {
    const img = makeDocument(20, 30);
    let out: GrayImage = img;
    for (let i = 0; i < 4; i++) out = rotateGray90(out);
    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });
});

describe('inkCentroidX()', () => {
  it('deteta a margem esquerda de um documento de texto', () => {
    expect(inkCentroidX(makeDocument())).toBeLessThan(0.5);
  });
  it('devolve o centro quando não há tinta nenhuma', () => {
    expect(inkCentroidX({ width: 10, height: 10, data: new Uint8Array(100).fill(255) })).toBe(0.5);
  });
});

describe('fitWithinMaxEdge()', () => {
  it('não mexe numa imagem que já cabe', () => {
    expect(fitWithinMaxEdge(1000, 1400)).toEqual({ width: 1000, height: 1400, scaled: false });
  });
  it('reduz mantendo a proporção', () => {
    const out = fitWithinMaxEdge(4000, 3000);
    expect(out.scaled).toBe(true);
    expect(Math.max(out.width, out.height)).toBe(ARCHIVE_MAX_EDGE);
    expect(out.width / out.height).toBeCloseTo(4000 / 3000, 2);
  });
  it('o orçamento de arquivo é o pedido pelo cliente: 500 KB', () => {
    expect(ARCHIVE_MAX_BYTES).toBe(500 * 1024);
  });
});
