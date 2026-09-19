import { DocumentOrigin } from '@prisma/client';
import { MicrosoftGraphService } from '../microsoft-graph.service';

describe('MicrosoftGraphService — Client Credentials & Multichannel Ingestion', () => {
  let service: MicrosoftGraphService;
  let prismaMock: any;
  let inboundMock: any;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.MS_TENANT_ID = 'test-tenant-id';
    process.env.MS_CLIENT_ID = 'test-client-id';
    process.env.MS_CLIENT_SECRET = 'test-client-secret';
    process.env.MS_MAILBOX = 'financeiro@hotelequip.pt';

    prismaMock = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-demo', nif: '515208566', active: true }),
        findUnique: jest.fn().mockResolvedValue({ id: 'tenant-demo', nif: '515208566', active: true }),
      },
      document: {
        groupBy: jest.fn().mockResolvedValue([{ origin: 'EMAIL', _count: { id: 5 } }]),
        count: jest.fn().mockResolvedValue(10),
      },
    };

    inboundMock = {
      ingestFiles: jest.fn().mockResolvedValue([{ id: 'doc-1', fileName: 'fatura.pdf' }]),
    };

    service = new MicrosoftGraphService(prismaMock, inboundMock);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('Authentication & Token Caching', () => {
    it('obtains token via client_credentials and caches it', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('/oauth2/v2.0/token')) {
          callCount++;
          expect(init.method).toBe('POST');
          const body = String(init.body);
          expect(body).toContain('client_id=test-client-id');
          expect(body).toContain('client_secret=test-client-secret');
          expect(body).toContain('grant_type=client_credentials');
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'mock-token-123', expires_in: 3600 }),
          };
        }
        return { ok: false, status: 404 };
      }) as any;

      const token1 = await service.getAccessToken();
      const token2 = await service.getAccessToken();

      expect(token1).toBe('mock-token-123');
      expect(token2).toBe('mock-token-123');
      expect(callCount).toBe(1); // Cached, only 1 fetch call
    });

    it('throws when MS_CLIENT_SECRET is missing', async () => {
      delete process.env.MS_CLIENT_SECRET;
      delete process.env.MICROSOFT_CLIENT_SECRET;
      await expect(service.getAccessToken()).rejects.toThrow(/MS_CLIENT_SECRET/);
    });
  });

  describe('P0.1 — Recursive itemAttachment Unwrapping & Provenance', () => {
    it('unwraps nested forwarded email attachments and preserves provenance', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 invoice payload');
      const mockMessage = {
        id: 'msg-top-1',
        internetMessageId: '<top@hotelequip.pt>',
        subject: 'Fwd: Faturas do Fornecedor',
        receivedDateTime: '2026-09-12T10:00:00Z',
        from: { emailAddress: { address: 'geral@hotelequip.pt' } },
        toRecipients: [{ emailAddress: { address: 'financeiro@hotelequip.pt' } }],
        attachments: [
          {
            '@odata.type': '#microsoft.graph.itemAttachment',
            id: 'att-forwarded-email',
            name: 'Original Message.eml',
            contentType: 'message/rfc822',
            item: {
              id: 'msg-nested-1',
              internetMessageId: '<original@fornecedor.pt>',
              subject: 'Fatura FT 2026/99',
              receivedDateTime: '2026-09-12T09:30:00Z',
              from: { emailAddress: { address: 'contabilidade@fornecedor.pt' } },
              toRecipients: [{ emailAddress: { address: 'geral@hotelequip.pt' } }],
              attachments: [
                {
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  id: 'att-pdf-1',
                  name: 'Invoice-2026-99.pdf',
                  contentType: 'application/pdf',
                  size: pdfBytes.length,
                  contentBytes: pdfBytes.toString('base64'),
                },
                {
                  // Inline signature logo to be ignored
                  '@odata.type': '#microsoft.graph.fileAttachment',
                  id: 'att-logo',
                  name: 'logo.png',
                  contentType: 'image/png',
                  size: 2048,
                  isInline: true,
                },
              ],
            },
          },
        ],
      };

      const result = await service.extractAttachmentsFromMessage('token', 'users/financeiro', mockMessage);

      expect(result.attachments).toHaveLength(1);
      const att = result.attachments[0];
      expect(att.originalname).toBe('Invoice-2026-99.pdf');
      expect(att.mimetype).toBe('application/pdf');
      expect(att.metadata.originalSender).toBe('contabilidade@fornecedor.pt');
      expect(att.metadata.originalSubject).toBe('Fatura FT 2026/99');
      expect(att.metadata.originalMailbox).toBe('geral@hotelequip.pt');
      expect(att.metadata.originalDate).toBe('2026-09-12T09:30:00Z');
    });

    it('scans email body for billing download links (Moloni, TOConline)', async () => {
      const mockMessage = {
        id: 'msg-link-only',
        subject: 'A sua fatura está pronta',
        from: { emailAddress: { address: 'faturas@moloni.pt' } },
        body: {
          content: 'Consulte o seu documento fiscal no link: https://www.moloni.pt/download/FT123456 Obrigado!',
        },
        attachments: [],
      };

      const result = await service.extractAttachmentsFromMessage('token', 'users/financeiro', mockMessage);

      expect(result.attachments).toHaveLength(0);
      expect(result.downloadLinks).toContain('https://www.moloni.pt/download/FT123456');
    });
  });

  describe('OneDrive Ingestion (/DocFlow/Entrada → /DocFlow/Processados)', () => {
    it('downloads files from /DocFlow/Entrada, ingests with ONEDRIVE origin, and moves to Processados', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 onedrive doc');
      let moveCalled = false;

      global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
        if (url.includes('/oauth2/v2.0/token')) {
          return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
        }
        if (url.includes('/drive/root:/DocFlow/Entrada:/children')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              value: [
                {
                  id: 'item-101',
                  name: 'Scanner_Fatura_55.pdf',
                  size: pdfBytes.length,
                  file: { mimeType: 'application/pdf' },
                  createdDateTime: '2026-09-14T08:00:00Z',
                },
              ],
            }),
          };
        }
        if (url.includes('/drive/items/item-101/content')) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength),
          };
        }
        if (url.includes('/drive/root:/DocFlow/Processados')) {
          return { ok: true, status: 200, json: async () => ({ id: 'folder-proc-id' }) };
        }
        if (url.includes('/drive/items/item-101') && init?.method === 'PATCH') {
          moveCalled = true;
          return { ok: true, status: 200, json: async () => ({ id: 'item-101' }) };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }) as any;

      const result = await service.pollOneDrive('tenant-demo');

      expect(result.processed).toBe(1);
      expect(inboundMock.ingestFiles).toHaveBeenCalledWith(
        'tenant-demo',
        expect.arrayContaining([
          expect.objectContaining({
            originalname: 'Scanner_Fatura_55.pdf',
            mimetype: 'application/pdf',
          }),
        ]),
        DocumentOrigin.ONEDRIVE,
        expect.objectContaining({
          source: 'onedrive',
          itemId: 'item-101',
        }),
      );
      expect(moveCalled).toBe(true);
    });
  });

  describe('Error Handling & 403 ApplicationAccessPolicy', () => {
    it('handles 403 on mailbox gracefully without throwing', async () => {
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        if (url.includes('/oauth2/v2.0/token')) {
          return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
        }
        if (url.includes('/messages')) {
          return { ok: false, status: 403, text: async () => 'ApplicationAccessPolicy forbidden' };
        }
        if (url.includes('/mailFolders')) {
          return { ok: true, status: 200, json: async () => ({ value: [{ displayName: 'Faturas', id: 'f-1' }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ value: [] }) };
      }) as any;

      const result = await service.pollMailbox('tenant-demo');
      expect(result.processed).toBe(0);
      expect(result.errors).toContain('403 ApplicationAccessPolicy restriction');
    });
  });
});
