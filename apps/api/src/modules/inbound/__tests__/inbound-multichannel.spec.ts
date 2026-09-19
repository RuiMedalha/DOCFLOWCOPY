import { BadRequestException } from '@nestjs/common';
import { DocumentOrigin, DocumentProcessingStatus, DocumentStatus } from '@prisma/client';
import { InboundService } from '../inbound.service';

describe('InboundService — Multichannel, WhatsApp Evolution API & Deduplication', () => {
  let svc: InboundService;
  let prismaMock: any;
  let storageMock: any;
  let extractionMock: any;

  beforeEach(() => {
    prismaMock = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-demo', nif: '515208566', active: true }),
        findUnique: jest.fn().mockResolvedValue({ id: 'tenant-demo', nif: '515208566', active: true }),
      },
      document: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'doc-' + Math.random().toString(36).slice(2, 7),
          fileName: data.fileName,
          origin: data.origin,
          status: data.status,
          processingStatus: data.processingStatus,
        })),
        groupBy: jest.fn().mockResolvedValue([
          { origin: 'UPLOAD', _count: { id: 10 } },
          { origin: 'EMAIL', _count: { id: 5 } },
          { origin: 'ONEDRIVE', _count: { id: 3 } },
          { origin: 'WHATSAPP', _count: { id: 2 } },
        ]),
        count: jest.fn().mockResolvedValue(20),
      },
    };

    storageMock = {
      put: jest.fn().mockResolvedValue(undefined),
      getBuffer: jest.fn().mockResolvedValue({ buffer: Buffer.from(''), size: 0 }),
    };

    extractionMock = {
      enqueue: jest.fn().mockResolvedValue(undefined),
    };

    svc = new InboundService(prismaMock as any, storageMock as any, extractionMock as any);
  });

  describe('Deduplication by SHA-256', () => {
    it('creates fresh document when hash is not in DB and enqueues extraction', async () => {
      const file = {
        buffer: Buffer.from('%PDF-1.4 fresh invoice'),
        originalname: 'invoice.pdf',
        mimetype: 'application/pdf',
        size: 22,
      };

      const result = await svc.ingestFiles('tenant-demo', [file], DocumentOrigin.EMAIL, { source: 'test' });

      expect(result).toHaveLength(1);
      expect(prismaMock.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: DocumentOrigin.EMAIL,
            status: DocumentStatus.NOVO,
            processingStatus: DocumentProcessingStatus.RECEIVED,
          }),
        }),
      );
      expect(extractionMock.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-demo',
          documentId: result[0].id,
        }),
      );
    });

    it('returns existing document on duplicate SHA-256 and does NOT re-enqueue extraction', async () => {
      const existingDoc = { id: 'doc-existing-123', fileName: 'invoice.pdf' };
      prismaMock.document.findFirst.mockResolvedValue(existingDoc);

      const file = {
        buffer: Buffer.from('%PDF-1.4 duplicate invoice'),
        originalname: 'invoice.pdf',
        mimetype: 'application/pdf',
        size: 26,
      };

      const result = await svc.ingestFiles('tenant-demo', [file], DocumentOrigin.EMAIL, { source: 'test' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('doc-existing-123');
      expect(prismaMock.document.create).not.toHaveBeenCalled();
      expect(extractionMock.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('WhatsApp Ingestion (Evolution API)', () => {
    it('accepts base64 document message payload with WHATSAPP origin', async () => {
      const pdfBase64 = Buffer.from('%PDF-1.4 whatsapp invoice content').toString('base64');
      const payload = {
        event: 'messages.upsert',
        data: {
          key: {
            remoteJid: '351912345678@s.whatsapp.net',
            id: 'WA-MSG-999',
          },
          pushName: 'Manuel Fornecedor',
          message: {
            documentMessage: {
              fileName: 'Fatura_Fornecedor_WA.pdf',
              mimetype: 'application/pdf',
              base64: pdfBase64,
            },
          },
        },
      };

      const result = await svc.ingestWhatsApp(payload);

      expect(result.processed).toBe(1);
      expect(result.documents).toHaveLength(1);
      expect(prismaMock.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: DocumentOrigin.WHATSAPP,
            fileName: 'Fatura_Fornecedor_WA.pdf',
            metadata: expect.objectContaining({
              source: 'whatsapp-evolution',
              phone: '351912345678',
              senderName: 'Manuel Fornecedor',
              messageId: 'WA-MSG-999',
            }),
          }),
        }),
      );
    });

    it('throws BadRequestException when no media is present in WhatsApp payload', async () => {
      const payload = {
        event: 'messages.upsert',
        data: {
          key: { remoteJid: '351912345678@s.whatsapp.net' },
          message: { conversation: 'Olá, bom dia!' },
        },
      };

      await expect(svc.ingestWhatsApp(payload)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Direct Upload Ingestion', () => {
    it('ingests multipart files with custom origin', async () => {
      const file = {
        buffer: Buffer.from('%PDF-1.4 manual upload'),
        originalname: 'manual_fatura.pdf',
        mimetype: 'application/pdf',
        size: 25,
      } as unknown as Express.Multer.File;

      const result = await svc.ingestDirectUpload('tenant-demo', [file], DocumentOrigin.UPLOAD, {
        uploadedBy: 'admin',
      });

      expect(result.processed).toBe(1);
      expect(prismaMock.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            origin: DocumentOrigin.UPLOAD,
            fileName: 'manual_fatura.pdf',
          }),
        }),
      );
    });
  });

  describe('Inbound Status', () => {
    it('returns aggregated totals by origin and recent 24h count', async () => {
      const status = await svc.getInboundStatus();

      expect(status.totalByOrigin).toEqual({
        UPLOAD: 10,
        EMAIL: 5,
        ONEDRIVE: 3,
        WHATSAPP: 2,
      });
      expect(status.recent24hCount).toBe(20);
    });
  });
});
