import sharp from 'sharp';
import {
  sortCorners,
  cropPerspectiveIfConfident,
  Point,
} from '../perspective-crop';

describe('PerspectiveCrop', () => {
  describe('sortCorners', () => {
    it('orders corners canonically: [TL, TR, BR, BL]', () => {
      const unord: Point[] = [
        { x: 300, y: 400 }, // BR
        { x: 20, y: 30 },   // TL
        { x: 25, y: 380 },  // BL
        { x: 310, y: 40 },  // TR
      ];

      const [tl, tr, br, bl] = sortCorners(unord);
      expect(tl.x).toBe(20);
      expect(tl.y).toBe(30);

      expect(tr.x).toBe(310);
      expect(tr.y).toBe(40);

      expect(br.x).toBe(300);
      expect(br.y).toBe(400);

      expect(bl.x).toBe(25);
      expect(bl.y).toBe(380);
    });
  });

  describe('cropPerspectiveIfConfident', () => {
    it('returns applied=false when background is uniform/flat (no paper boundary)', async () => {
      // Imagem lisa cinzenta sem documento
      const flatImage = await sharp({
        create: {
          width: 200,
          height: 200,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .jpeg()
        .toBuffer();

      const res = await cropPerspectiveIfConfident(flatImage, 'image/jpeg');
      expect(res.applied).toBe(false);
      expect(res.confidence).toBeLessThan(0.65);
      expect(res.buffer).toEqual(flatImage);
    });

    it('safely falls back for unsupported mime types (e.g. PDF)', async () => {
      const dummyPdf = Buffer.from('%PDF-1.4 mock');
      const res = await cropPerspectiveIfConfident(dummyPdf, 'application/pdf');
      expect(res.applied).toBe(false);
      expect(res.confidence).toBe(0);
      expect(res.buffer).toBe(dummyPdf);
    });

    it('detects a clear bright paper quadrilateral on dark desk and rectifies it', async () => {
      // Criar imagem de 400x400: mesa escura (r=30, g=30, b=30)
      // e sobre ela um documento claro desenhado em perspetiva (r=240, g=240, b=240)
      const svgDoc = `
        <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
          <rect width="400" height="400" fill="#1e1e1e" />
          <polygon points="60,80 320,60 350,340 70,360" fill="#fafafa" />
          <text x="100" y="150" font-size="20" fill="#000000">FATURA TESTE</text>
        </svg>
      `;

      const photo = await sharp(Buffer.from(svgDoc)).jpeg().toBuffer();

      const res = await cropPerspectiveIfConfident(photo, 'image/jpeg');
      expect(res.confidence).toBeGreaterThanOrEqual(0.65);
      expect(res.applied).toBe(true);
      expect(res.corners).toBeDefined();
      expect(res.corners!.length).toBe(4);
      expect(res.buffer.length).toBeGreaterThan(0);

      // O resultado é um JPEG válido e retificado
      const meta = await sharp(res.buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeGreaterThan(150);
      expect(meta.height).toBeGreaterThan(150);
    });
  });
});
