import { BadRequestException } from '@nestjs/common';
import { DocumentOrigin } from '@prisma/client';
import { OutlookService } from '../outlook.service';

/**
 * Tests for OutlookService — Microsoft Graph Inbound with Client Credentials
 * and ApplicationAccessPolicy targeting financeiro@hotelequip.pt.
 */
describe('OutlookService — Client Credentials & Single Channel Policy', () => {
  let service: OutlookService;
  let prismaMock: any;
  let inboundMock: any;
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    process.env.MS_TENANT_ID = 'f27c295b-2490-4101-9ae3-6db45ffd9489';
    process.env.MS_CLIENT_ID = '0dcb16b8-3214-49c2-ab13-80c7e07fa332';
    process.env.MS_CLIENT_SECRET = 'test-client-secret';
    process.env.MS_MAILBOX = 'financeiro@hotelequip.pt';
    process.env.MS_MAIL_FOLDER = 'Faturas';

    prismaMock = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-123', nif: '515208566' }),
      },
    };

    inboundMock = {
      ingestFiles: jest.fn().mockResolvedValue([{ id: 'doc-1' }]),
    };

    service = new OutlookService(prismaMock, inboundMock);
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  describe('Single-Channel Policy: Delegated OAuth Deactivated', () => {
    it('generateAuthUrl throws BadRequestException', async () => {
      await expect(service.generateAuthUrl('tenant-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('handleCallback throws BadRequestException', async () => {
      await expect(service.handleCallback('code', 'state', 'tenant-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Client Credentials Token', () => {
    it('obtains and caches an application bearer token', async () => {
      (globalThis as any).fetch = jest.fn().mockImplementation(async (url: any) => {
        if (String(url).includes('/oauth2/v2.0/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'test-app-token',
              expires_in: 3600,
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      });

      const token1 = await service.getAccessToken();
      expect(token1).toBe('test-app-token');

      // Second call uses memory cache
      const token2 = await service.getAccessToken();
      expect(token2).toBe('test-app-token');
      expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Mailbox Polling & Attachment Ingestion (Faturas -> Faturas/Processado)', () => {
    it('reads messages in Faturas, extracts attachments, marks as read and moves to Processado', async () => {
      const calls: string[] = [];

      (globalThis as any).fetch = jest.fn().mockImplementation(async (url: any, init: any) => {
        const u = String(url);
        calls.push(`${init?.method || 'GET'} ${u}`);

        if (u.includes('/oauth2/v2.0/token')) {
          return new Response(JSON.stringify({ access_token: 'token-xyz', expires_in: 3600 }), {
            status: 200,
          });
        }
        if (u.endsWith('/users/financeiro%40hotelequip.pt')) {
          return new Response(JSON.stringify({ id: 'user-id-1' }), { status: 200 });
        }
        // Faturas folder resolution
        if (u.includes('/mailFolders') && !u.includes('/messages') && !u.includes('/childFolders')) {
          return new Response(
            JSON.stringify({
              value: [
                { id: 'inbox-id', displayName: 'Inbox' },
                { id: 'faturas-id', displayName: 'Faturas' },
              ],
            }),
            { status: 200 },
          );
        }
        // Child folders in Faturas (Processado)
        if (u.includes('/faturas-id/childFolders')) {
          return new Response(
            JSON.stringify({
              value: [{ id: 'processado-id', displayName: 'Processado' }],
            }),
            { status: 200 },
          );
        }
        // Unread messages in Faturas folder
        if (u.includes('/faturas-id/messages')) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: 'msg-1',
                  subject: 'Fatura Fornecedor XYZ',
                  receivedDateTime: '2026-09-14T09:00:00Z',
                  from: { emailAddress: { address: 'fornecedor@xyz.com' } },
                  attachments: [
                    {
                      '@odata.type': '#microsoft.graph.fileAttachment',
                      id: 'att-1',
                      name: 'FT2026_001.pdf',
                      contentType: 'application/pdf',
                      size: 1024,
                      contentBytes: Buffer.from('dummy-pdf-content').toString('base64'),
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }
        // Mark as read PATCH
        if (u.includes('/messages/msg-1') && init?.method === 'PATCH') {
          return new Response(JSON.stringify({ isRead: true }), { status: 200 });
        }
        // Move message POST
        if (u.includes('/messages/msg-1/move') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'msg-1-moved' }), { status: 200 });
        }

        return new Response('{}', { status: 200 });
      });

      const res = await service.pollMailbox('tenant-123');
      expect(res.processed).toBe(1);
      expect(inboundMock.ingestFiles).toHaveBeenCalledWith(
        'tenant-123',
        expect.arrayContaining([
          expect.objectContaining({
            originalname: 'FT2026_001.pdf',
            mimetype: 'application/pdf',
          }),
        ]),
        DocumentOrigin.EMAIL,
        expect.objectContaining({
          originalSender: 'fornecedor@xyz.com',
          originalSubject: 'Fatura Fornecedor XYZ',
        }),
      );

      // Verify move to Processado folder was called
      expect(calls.some((c) => c.includes('POST') && c.includes('/messages/msg-1/move'))).toBe(true);
    });
  });

  describe('Filtering Junk Attachments and Non-Invoice Emails', () => {
    it('should ignore email signature images, logos, and tiny icons', () => {
      expect(service.shouldIgnoreAttachment('image001.png', 'image/png', 15000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('image002.jpg', 'image/jpeg', 22000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('logo_company.png', 'image/png', 50000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('signature.png', 'image/png', 45000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('facebook.png', 'image/png', 12000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('linkedin_icon.png', 'image/png', 8000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('banner_rodape.jpg', 'image/jpeg', 80000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('tiny.jpg', 'image/jpeg', 10000).ignore).toBe(true);
    });

    it('should ignore non-invoice marketing and legal documents', () => {
      expect(service.shouldIgnoreAttachment('catalogo_2026.pdf', 'application/pdf', 500000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('brochura_produtos.pdf', 'application/pdf', 400000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('termos_e_condicoes.pdf', 'application/pdf', 120000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('politica_privacidade.pdf', 'application/pdf', 90000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('manual_utilizador.pdf', 'application/pdf', 850000).ignore).toBe(true);
      expect(service.shouldIgnoreAttachment('newsletter_setembro.pdf', 'application/pdf', 300000).ignore).toBe(true);
    });

    it('should accept valid invoice and receipt documents', () => {
      expect(service.shouldIgnoreAttachment('FT_2026_123.pdf', 'application/pdf', 120000).ignore).toBe(false);
      expect(service.shouldIgnoreAttachment('fatura_fornecedor.pdf', 'application/pdf', 250000).ignore).toBe(false);
      expect(service.shouldIgnoreAttachment('scan_documento.pdf', 'application/pdf', 150000).ignore).toBe(false);
      expect(service.shouldIgnoreAttachment('foto_recibo.jpg', 'image/jpeg', 350000).ignore).toBe(false);
    });

    it('should identify spam and marketing email subjects', () => {
      expect(service.shouldIgnoreEmailSubject('Newsletter Semanal Setembro')).toBe(true);
      expect(service.shouldIgnoreEmailSubject('Boas Festas e Feliz Ano Novo')).toBe(true);
      expect(service.shouldIgnoreEmailSubject('Aviso de Férias da Empresa')).toBe(true);
      expect(service.shouldIgnoreEmailSubject('Pesquisa de Satisfação de Clientes')).toBe(true);
    });

    it('should never ignore emails with invoice signals', () => {
      expect(service.shouldIgnoreEmailSubject('Envio de Fatura FT 2026/001')).toBe(false);
      expect(service.shouldIgnoreEmailSubject('Factura e Recibo de Pagamento')).toBe(false);
      expect(service.shouldIgnoreEmailSubject('Invoice INV-2026-999')).toBe(false);
      expect(service.shouldIgnoreEmailSubject('Nota de Crédito NC 12')).toBe(false);
      expect(service.shouldIgnoreEmailSubject('Aviso de Vencimento de Fatura')).toBe(false);
    });
  });

  describe('Sender Whitelist and Blacklist Filtering', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('blocks senders listed in MS_MAIL_BLOCKED_SENDERS', () => {
      process.env.MS_MAIL_BLOCKED_SENDERS = 'marketing@spam.com, spammer@bad.org, @newsletter.pt';

      expect(service.isSenderBlocked('marketing@spam.com')).toBe(true);
      expect(service.isSenderBlocked('info@newsletter.pt')).toBe(true);
      expect(service.isSenderBlocked('spammer@bad.org')).toBe(true);
      expect(service.isSenderBlocked('fornecedor@bom.pt')).toBe(false);
      expect(service.isSenderBlocked(null)).toBe(false);
    });

    it('enforces whitelist when MS_MAIL_ALLOWED_SENDERS is configured', () => {
      process.env.MS_MAIL_ALLOWED_SENDERS = 'faturas@vodafone.pt, contabilidade@nos.pt';

      expect(service.isSenderAllowed('faturas@vodafone.pt')).toBe(true);
      expect(service.isSenderAllowed('contabilidade@nos.pt')).toBe(true);
      expect(service.isSenderAllowed('outro@fornecedor.pt')).toBe(false);
    });

    it('allows all senders when MS_MAIL_ALLOWED_SENDERS is empty', () => {
      delete process.env.MS_MAIL_ALLOWED_SENDERS;
      expect(service.isSenderAllowed('qualquer@fornecedor.pt')).toBe(true);
    });

    it('respects MS_MAIL_MOVE_ENABLED=false to only mark as read and not move', () => {
      process.env.MS_MAIL_MOVE_ENABLED = 'false';
      expect(service.mailMoveEnabled).toBe(false);

      delete process.env.MS_MAIL_MOVE_ENABLED;
      expect(service.mailMoveEnabled).toBe(true);
    });
  });
});

