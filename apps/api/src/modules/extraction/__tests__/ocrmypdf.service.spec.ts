import { Test, TestingModule } from '@nestjs/testing';
import { OcrmypdfService, OcrmypdfOptions } from '../ocrmypdf.service';
import { ImageToPdfService } from '../../documents/image-to-pdf/image-to-pdf.service';
import * as childProcess from 'child_process';
import * as fs from 'fs';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

describe('OcrmypdfService', () => {
  let service: OcrmypdfService;
  let imageToPdf: jest.Mocked<ImageToPdfService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockImageToPdf = {
      convert: jest.fn().mockResolvedValue(Buffer.from('%PDF-fallback%')),
      supports: jest.fn().mockImplementation((mime: string) => /^image\/(jpeg|jpg|png|webp)$/i.test(mime)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OcrmypdfService,
        {
          provide: ImageToPdfService,
          useValue: mockImageToPdf,
        },
      ],
    }).compile();

    service = module.get<OcrmypdfService>(OcrmypdfService);
    imageToPdf = module.get(ImageToPdfService);
  });

  describe('buildArgs', () => {
    it('deve incluir as flags comprovadas padrão para conformidade legal (art. 52.º CIVA)', () => {
      const args = service.buildArgs('/tmp/input.jpg', '/tmp/output.pdf');

      expect(args).toContain('--deskew');
      expect(args).toContain('--clean');
      expect(args).toContain('--output-type');
      expect(args).toContain('pdfa-2');
      expect(args).toContain('-l');
      expect(args).toContain('por');
      expect(args).toContain('--skip-text');
      expect(args[args.length - 2]).toBe('/tmp/input.jpg');
      expect(args[args.length - 1]).toBe('/tmp/output.pdf');
    });

    it('deve respeitar opções personalizadas', () => {
      const opts: OcrmypdfOptions = {
        deskew: false,
        clean: false,
        outputType: 'pdfa-3',
        language: 'por+eng',
        rotatePages: true,
        skipText: false,
        extraArgs: ['--title', 'Fatura'],
      };

      const args = service.buildArgs('/tmp/doc.pdf', '/tmp/doc.pdfa.pdf', opts);

      expect(args).not.toContain('--deskew');
      expect(args).not.toContain('--clean');
      expect(args).toContain('pdfa-3');
      expect(args).toContain('por+eng');
      expect(args).toContain('--rotate-pages');
      expect(args).not.toContain('--skip-text');
      expect(args).toContain('--title');
      expect(args).toContain('Fatura');
    });
  });

  describe('isAvailable', () => {
    it('retorna true quando o comando ocrmypdf --version tem sucesso', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        cb(null, { stdout: 'OCRmyPDF 16.0.0\n', stderr: '' });
      });

      const available = await service.isAvailable(true);
      expect(available).toBe(true);
      expect(execFileMock).toHaveBeenCalledWith('ocrmypdf', ['--version'], expect.any(Object), expect.any(Function));
    });

    it('retorna false quando ocrmypdf não existe no sistema (ex: Windows local sem o binário)', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        const err = new Error('spawn ocrmypdf ENOENT');
        (err as any).code = 'ENOENT';
        cb(err);
      });

      const available = await service.isAvailable(true);
      expect(available).toBe(false);
    });
  });

  describe('processImageOrPdf com ocrmypdf disponível', () => {
    it('executa ocrmypdf e devolve o PDF/A resultante, limpando os ficheiros temporários', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      // isAvailable -> true
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        if (args && args[0] === '--version') {
          return cb(null, { stdout: 'OCRmyPDF 16.0.0', stderr: '' });
        }
        // Simula a execução do ocrmypdf escrevendo o PDF de saída
        const outputPath = args[args.length - 1];
        fs.writeFileSync(outputPath, Buffer.from('%PDF-1.4 PDF/A-2b result%'));
        cb(null, { stdout: 'Output file created', stderr: '' });
      });

      const inputBuffer = Buffer.from('fake-image-bytes');
      const result = await service.processImageOrPdf(inputBuffer, 'image/jpeg');

      expect(result.toString()).toContain('PDF/A-2b');
      expect(imageToPdf.convert).not.toHaveBeenCalled();
    });
  });

  describe('Fallback gracioso (Ambiente de desenvolvimento Windows / Binário em falta)', () => {
    it('degrada suavemente para ImageToPdfService para imagens quando ocrmypdf não está instalado', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('ENOENT'));
      });

      const inputBuffer = Buffer.from('fake-jpg-content');
      const result = await service.processImageOrPdf(inputBuffer, 'image/jpeg');

      expect(imageToPdf.convert).toHaveBeenCalledWith(inputBuffer, 'image/jpeg');
      expect(result.toString()).toBe('%PDF-fallback%');
    });

    it('degrada suavemente devolvendo o próprio PDF se a entrada for PDF e ocrmypdf não estiver disponível', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('ENOENT'));
      });

      const pdfBuffer = Buffer.from('%PDF-original%');
      const result = await service.processImageOrPdf(pdfBuffer, 'application/pdf');

      expect(imageToPdf.convert).not.toHaveBeenCalled();
      expect(result).toBe(pdfBuffer);
    });

    it('faz fallback para ImageToPdfService se ocrmypdf falhar durante o processamento', async () => {
      const execFileMock = childProcess.execFile as unknown as jest.Mock;
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        if (args && args[0] === '--version') {
          return cb(null, { stdout: 'OCRmyPDF 16.0.0', stderr: '' });
        }
        // Falha durante a execução do ocrmypdf (ex: imagem corrompida)
        cb(new Error('Input file is corrupted'));
      });

      const inputBuffer = Buffer.from('corrupted-image');
      const result = await service.processImageOrPdf(inputBuffer, 'image/png');

      expect(imageToPdf.convert).toHaveBeenCalledWith(inputBuffer, 'image/png');
      expect(result.toString()).toBe('%PDF-fallback%');
    });
  });
});
