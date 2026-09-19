import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ImageToPdfService } from '../documents/image-to-pdf/image-to-pdf.service';

const execFileAsync = promisify(execFile);

export interface OcrmypdfOptions {
  /**
   * Alinha / endireita páginas rodadas ou tortas (--deskew).
   * Default: true.
   */
  deskew?: boolean;
  /**
   * Limpa artefatos e ruído antes do OCR (--clean).
   * Default: true.
   */
  clean?: boolean;
  /**
   * Nível / versão de saída PDF/A (--output-type).
   * Default: 'pdfa-2' (para conformidade legal art. 52.º CIVA).
   */
  outputType?: 'pdfa-1' | 'pdfa-2' | 'pdfa-3' | 'pdfa' | 'pdf';
  /**
   * Idioma do Tesseract (-l).
   * Default: 'por' (português).
   */
  language?: string;
  /**
   * Se o PDF de entrada já tiver texto, não aborta e preserva o texto existente (--skip-text).
   * Default: true.
   */
  skipText?: boolean;
  /**
   * Detecta e roda páginas se o Tesseract identificar rotação 90/180/270 (--rotate-pages).
   * Default: false.
   */
  rotatePages?: boolean;
  /**
   * Timeout máximo da execução em ms.
   * Default: 120000 (2 minutos).
   */
  timeoutMs?: number;
  /**
   * Argumentos extras para ocrmypdf.
   */
  extraArgs?: string[];
}

/**
 * OcrmypdfService — integração do OCRmyPDF no DocFlow seguindo o padrão
 * arquitetural do Paperless-ngx e Papermerge.
 *
 * Garante que fotos e digitalizações processadas são limpas, endireitadas
 * e convertidas num PDF/A legal (art. 52.º CIVA) com camada de texto
 * invisível pesquisável.
 *
 * Flags comprovadas padrão:
 *   ocrmypdf --deskew --clean --output-type pdfa-2 -l por <input> <output>
 *
 * Fallback gracioso:
 * Se o binário ocrmypdf não estiver presente no sistema local (ex.: ambiente
 * Windows de desenvolvimento), degrada suavemente para o serviço ImageToPdfService
 * existente (pdf-lib) sem quebrar a execução.
 */
@Injectable()
export class OcrmypdfService implements OnModuleInit {
  private readonly logger = new Logger(OcrmypdfService.name);
  private binaryAvailable: boolean | null = null;

  constructor(
    @Optional()
    private readonly imageToPdf?: ImageToPdfService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Verificação proativa no boot da aplicação (assíncrona sem bloquear startup)
    this.isAvailable().then((available) => {
      if (available) {
        this.logger.log(
          '[OcrmypdfService] Binário ocrmypdf DETETADO no sistema — processamento PDF/A (art. 52.º CIVA) ativo.',
        );
      } else {
        this.logger.warn(
          '[OcrmypdfService] Binário ocrmypdf NÃO encontrado no sistema — fallback ativo para ImageToPdfService.',
        );
      }
    }).catch((err) => {
      this.logger.warn(
        `[OcrmypdfService] Erro ao testar binário ocrmypdf: ${(err as Error).message}. Fallback ativo.`,
      );
    });
  }

  /**
   * Testa se o binário ocrmypdf está acessível no PATH do sistema operacional.
   */
  async isAvailable(forceRefresh = false): Promise<boolean> {
    if (this.binaryAvailable !== null && !forceRefresh) {
      return this.binaryAvailable;
    }

    try {
      await execFileAsync('ocrmypdf', ['--version'], { timeout: 5000 });
      this.binaryAvailable = true;
    } catch (err) {
      this.binaryAvailable = false;
    }

    return this.binaryAvailable;
  }

  /**
   * Constrói os argumentos de linha de comando para o ocrmypdf.
   */
  buildArgs(inputPath: string, outputPath: string, options?: OcrmypdfOptions): string[] {
    const args: string[] = [];

    if (options?.deskew !== false) {
      args.push('--deskew');
    }

    if (options?.clean !== false) {
      args.push('--clean');
    }

    const outputType = options?.outputType ?? 'pdfa-2';
    args.push('--output-type', outputType);

    const language = options?.language ?? 'por';
    args.push('-l', language);

    if (options?.skipText !== false) {
      args.push('--skip-text');
    }

    if (options?.rotatePages) {
      args.push('--rotate-pages');
    }

    if (options?.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    args.push(inputPath, outputPath);
    return args;
  }

  /**
   * Executa o ocrmypdf diretamente sobre ficheiros no sistema de ficheiros.
   */
  async runOcrmypdf(inputPath: string, outputPath: string, options?: OcrmypdfOptions): Promise<void> {
    const args = this.buildArgs(inputPath, outputPath, options);
    const timeout = options?.timeoutMs ?? 120000;

    this.logger.debug(`[OcrmypdfService] Executando: ocrmypdf ${args.join(' ')}`);
    await execFileAsync('ocrmypdf', args, { timeout });
  }

  /**
   * Processa uma imagem ou PDF em memória (Buffer):
   * 1. Se ocrmypdf estiver disponível, executa-o produzindo um PDF/A-2 com camada OCR.
   * 2. Se ocrmypdf não estiver disponível ou falhar na execução, faz fallback gracioso
   *    para o ImageToPdfService para imagens, ou retorna o próprio PDF se for PDF.
   */
  async processImageOrPdf(
    input: Buffer,
    mimeType: string,
    options?: OcrmypdfOptions,
  ): Promise<Buffer> {
    const normalizedMime = mimeType.toLowerCase();
    const isAvailable = await this.isAvailable();

    if (!isAvailable) {
      this.logger.log(
        `[OcrmypdfService] ocrmypdf indisponível no ambiente. A usar fallback gracioso para mime=${normalizedMime}.`,
      );
      return this.fallback(input, normalizedMime);
    }

    const ext = this.getExtensionForMime(normalizedMime);
    const tmpDir = os.tmpdir();
    const uniqueId = randomUUID();
    const inputPath = path.join(tmpDir, `docflow-ocr-in-${uniqueId}${ext}`);
    const outputPath = path.join(tmpDir, `docflow-ocr-out-${uniqueId}.pdf`);

    try {
      await fs.promises.writeFile(inputPath, input);
      await this.runOcrmypdf(inputPath, outputPath, options);
      const resultPdf = await fs.promises.readFile(outputPath);
      this.logger.log(
        `[OcrmypdfService] PDF/A gerado com sucesso via ocrmypdf: in=${input.length}B out=${resultPdf.length}B mime=${normalizedMime}`,
      );
      return resultPdf;
    } catch (err) {
      this.logger.warn(
        `[OcrmypdfService] Falha na execução do ocrmypdf (${(err as Error).message}). A degradar suavemente para o serviço de fallback.`,
      );
      return this.fallback(input, normalizedMime);
    } finally {
      // Limpeza garantida de ficheiros temporários
      await this.cleanupFile(inputPath);
      await this.cleanupFile(outputPath);
    }
  }

  /**
   * Fallback gracioso: converte imagem para PDF via ImageToPdfService (pdf-lib),
   * ou retorna os bytes do próprio PDF se a entrada já for PDF.
   */
  private async fallback(input: Buffer, mimeType: string): Promise<Buffer> {
    if (mimeType === 'application/pdf') {
      return input;
    }

    if (this.imageToPdf && this.imageToPdf.supports(mimeType)) {
      return this.imageToPdf.convert(input, mimeType);
    }

    // Se for uma imagem mas o imageToPdf não estiver disponível por algum motivo,
    // lança erro explicativo em vez de corromper o arquivo
    throw new Error(
      `[OcrmypdfService] Não foi possível converter ${mimeType} para PDF: ocrmypdf e ImageToPdfService indisponíveis.`,
    );
  }

  private getExtensionForMime(mime: string): string {
    switch (mime) {
      case 'image/jpeg':
      case 'image/jpg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/tiff':
        return '.tiff';
      case 'application/pdf':
        return '.pdf';
      default:
        return '.img';
    }
  }

  private async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignora se o ficheiro não chegou a ser criado ou já foi removido
    }
  }
}
