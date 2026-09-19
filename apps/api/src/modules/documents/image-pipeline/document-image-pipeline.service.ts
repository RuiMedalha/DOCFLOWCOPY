import {
  Injectable,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isHeic, normaliseHeic } from '../../../common/images/heic';
import { StorageService } from '../storage/storage-service.interface';
import { ImageToPdfService } from '../image-to-pdf/image-to-pdf.service';
import { ImageEnhancerService } from '../../extraction/image-enhancer.service';
import { PerspectiveCropResult } from '../../extraction/perspective-crop';

export interface IngestFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface IngestFileResult {
  fileKey: string;
  fileHash: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  pdfKey: string | null;
  perspective?: PerspectiveCropResult;
}

@Injectable()
export class DocumentImagePipelineService {
  private readonly logger = new Logger(DocumentImagePipelineService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    private readonly imageToPdf: ImageToPdfService,
    @Optional() private readonly imageEnhancer?: ImageEnhancerService,
  ) {}

  /**
   * Processa ficheiros para ingestão uniforme (upload manual, email, OneDrive, scanner, whatsapp).
   * Garante que toda a imagem passa por:
   *   1. Normalização HEIC -> JPEG se necessário
   *   2. Rotação EXIF + Deteção e recorte de perspetiva (P0.3)
   *   3. Conversão para PDF A4 vertical oficial (P0.2)
   *   4. Armazenamento de fileKey (original/otimizado) e pdfKey (PDF derivado)
   */
  async processAndStore(
    tenantId: string,
    file: IngestFileInput,
    basePrefix: string = '_inbox',
  ): Promise<IngestFileResult> {
    let currentBuffer = file.buffer;
    let currentMime = file.mimetype;
    let currentName = file.originalname;
    let currentSize = file.size;

    // 1. HEIC / HEIF normalização para JPEG
    if (isHeic({ originalname: currentName, mimetype: currentMime, buffer: currentBuffer })) {
      try {
        const jpeg = await normaliseHeic(
          { originalname: currentName, mimetype: currentMime, buffer: currentBuffer, size: currentSize },
          this.logger,
        );
        if (jpeg) {
          currentBuffer = jpeg.buffer;
          currentMime = jpeg.mimetype;
          currentName = jpeg.originalname;
          currentSize = jpeg.size;
        }
      } catch (err) {
        this.logger.warn(`[DocumentImagePipeline] HEIC decode failed: ${(err as Error).message}`);
      }
    }

    const fileHash = createHash('sha256').update(currentBuffer).digest('hex');
    const safeName = currentName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(36).substring(2, 10);

    // Estrutura de chave previsível e consistente
    const fileKey = `${basePrefix}/${tenantId}/${yyyy}/${mm}/${Date.now()}-${rand}-${safeName}`;

    let pdfKey: string | null = null;
    let perspectiveResult: PerspectiveCropResult | undefined;
    let finalStoreSize = currentSize;

    // 2. Se for imagem suportada, aplicar pipeline completa de melhoramento + perspetiva + PDF A4
    if (this.imageToPdf.supports(currentMime)) {
      try {
        pdfKey = fileKey.replace(/\.[^.]+$/, '.pdf');
        let orientedBuffer = currentBuffer;
        let enhancedMime = currentMime;

        if (this.imageEnhancer && this.imageEnhancer.isAvailable()) {
          const enhanced = await this.imageEnhancer.processDocumentImageWithDetails(
            currentBuffer,
            currentMime,
            {
              autoRotate: true,
              perspectiveCrop: true,
              trim: true,
              normalizeContrast: true,
              sharpen: true,
            },
          );
          orientedBuffer = enhanced.buffer;
          enhancedMime = 'image/jpeg';
          perspectiveResult = enhanced.perspective;
        }

        // Se a imagem melhorada for diferente, atualizamos os bytes originais a gravar
        if (orientedBuffer !== currentBuffer) {
          currentBuffer = orientedBuffer;
          currentMime = enhancedMime;
          currentSize = orientedBuffer.length;
        }

        // 3. Converter para PDF A4
        const pdfBuffer = await this.imageToPdf.convert(orientedBuffer, currentMime);
        await this.storage.put(pdfKey, pdfBuffer, { contentType: 'application/pdf' });
        finalStoreSize = pdfBuffer.length || currentSize;
        this.logger.log(`[DocumentImagePipeline] PDF derivado gerado com sucesso: key=${pdfKey}`);
      } catch (err) {
        this.logger.warn(
          `[DocumentImagePipeline] Falha ao gerar PDF derivado para tenant=${tenantId} key=${fileKey}: ${
            (err as Error).message
          }`,
        );
        pdfKey = null;
      }
    }

    // Gravar o ficheiro principal (original ou melhorado)
    await this.storage.put(fileKey, currentBuffer, { contentType: currentMime });

    return {
      fileKey,
      fileHash,
      fileName: currentName,
      mimeType: currentMime,
      fileSize: finalStoreSize,
      pdfKey,
      perspective: perspectiveResult,
    };
  }
}
