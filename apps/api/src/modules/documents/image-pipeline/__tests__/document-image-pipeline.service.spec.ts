import sharp from 'sharp';
import { DocumentImagePipelineService } from '../document-image-pipeline.service';
import { ImageToPdfService } from '../../image-to-pdf/image-to-pdf.service';
import { ImageEnhancerService } from '../../../extraction/image-enhancer.service';

describe('DocumentImagePipelineService', () => {
  let service: DocumentImagePipelineService;
  let storageMock: any;
  let imageToPdf: ImageToPdfService;
  let imageEnhancer: ImageEnhancerService;

  beforeEach(() => {
    storageMock = {
      put: jest.fn().mockResolvedValue(undefined),
      getBuffer: jest.fn(),
    };
    imageToPdf = new ImageToPdfService();
    imageEnhancer = new ImageEnhancerService();
    service = new DocumentImagePipelineService(storageMock, imageToPdf, imageEnhancer);
  });

  it('processes image upload, creates A4 PDF derivative, and stores both fileKey and pdfKey', async () => {
    // Criar JPEG válido de 200x200
    const sampleJpeg = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await service.processAndStore('tenant-test', {
      buffer: sampleJpeg,
      mimetype: 'image/jpeg',
      originalname: 'fatura-almoco.jpg',
      size: sampleJpeg.length,
    });

    expect(result.fileKey).toContain('fatura-almoco');
    expect(result.pdfKey).toBeDefined();
    expect(result.pdfKey).toContain('.pdf');
    expect(result.mimeType).toBe('image/jpeg');
    expect(storageMock.put).toHaveBeenCalledTimes(2); // fileKey e pdfKey
  });

  it('keeps pdfKey=null for already PDF uploads', async () => {
    const samplePdf = Buffer.from('%PDF-1.4 mock content');

    const result = await service.processAndStore('tenant-test', {
      buffer: samplePdf,
      mimetype: 'application/pdf',
      originalname: 'fatura-edp.pdf',
      size: samplePdf.length,
    });

    expect(result.fileKey).toContain('fatura-edp');
    expect(result.pdfKey).toBeNull();
    expect(result.mimeType).toBe('application/pdf');
    expect(storageMock.put).toHaveBeenCalledTimes(1); // apenas o pdf original
  });
});
