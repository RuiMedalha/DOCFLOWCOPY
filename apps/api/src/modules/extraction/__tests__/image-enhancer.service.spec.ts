import { ImageEnhancerService } from '../image-enhancer.service';
import sharp from 'sharp';

describe('ImageEnhancerService (sharp / libvips acceleration)', () => {
  let service: ImageEnhancerService;
  let testImageBuffer: Buffer;

  beforeAll(async () => {
    service = new ImageEnhancerService();
    // Cria uma imagem sintética simples 100x100 para testes
    testImageBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 200, g: 200, b: 200 },
      },
    })
      .png()
      .toBuffer();
  });

  it('verifica se o motor sharp / libvips está disponível', () => {
    expect(service.isAvailable()).toBe(true);
  });

  it('executa auto-rotação com sucesso', async () => {
    const rotated = await service.autoRotate(testImageBuffer);
    expect(rotated).toBeInstanceOf(Buffer);
    expect(rotated.length).toBeGreaterThan(0);
  });

  it('executa pré-processamento de OCR com grayscale e contraste', async () => {
    const enhanced = await service.enhanceForOcr(testImageBuffer, {
      autoRotate: true,
      normalizeContrast: true,
      sharpen: true,
      binarize: true,
      threshold: 128,
    });
    expect(enhanced).toBeInstanceOf(Buffer);
    const meta = await service.getMetadata(enhanced);
    expect(meta).not.toBeNull();
    expect(meta?.channels).toBe(1); // Grayscale/monocromático
  });

  it('executa resgate de talões térmicos (rescueThermalReceipt)', async () => {
    const rescued = await service.rescueThermalReceipt(testImageBuffer);
    expect(rescued).toBeInstanceOf(Buffer);
    const meta = await service.getMetadata(rescued);
    expect(meta?.channels).toBe(1); // Grayscale com contraste esticado
  });

  it('prepara e otimiza imagens grandes para Visão IA', async () => {
    // Imagem sintética grande 3000x2000
    const largeBuffer = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();

    const result = await service.prepareForVisionAi(largeBuffer, 2048);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.width).toBeLessThanOrEqual(2048);
    expect(result.height).toBeLessThanOrEqual(2048);
    expect(result.optimizedBytes).toBeLessThan(result.originalBytes);
  });

  it('retorna metadados da imagem com getMetadata', async () => {
    const meta = await service.getMetadata(testImageBuffer);
    expect(meta).not.toBeNull();
    expect(meta?.width).toBe(100);
    expect(meta?.height).toBe(100);
  });
});
