import { InboundController } from '../inbound.controller';

describe('InboundController', () => {
  let controller: InboundController;
  let inboundServiceMock: any;
  let graphServiceMock: any;

  beforeEach(() => {
    inboundServiceMock = {
      saveImapConfig: jest.fn(),
      syncAll: jest.fn(),
      ingestWebhookEmail: jest.fn(),
      ingestScanner: jest.fn(),
      ingestDirectUpload: jest.fn().mockResolvedValue({ tenantId: 'tenant-1', processed: 1, documents: [{ id: 'doc-1' }] }),
      ingestWhatsApp: jest.fn().mockResolvedValue({ tenantId: 'tenant-1', processed: 1, documents: [{ id: 'doc-wa-1' }] }),
      getInboundStatus: jest.fn().mockResolvedValue({
        totalByOrigin: { UPLOAD: 5, EMAIL: 2, WHATSAPP: 1, ONEDRIVE: 1 },
        recent24hCount: 9,
      }),
    };

    graphServiceMock = {
      getStats: jest.fn().mockReturnValue({
        lastRunAt: new Date('2026-09-14T09:00:00Z'),
        lastRunStatus: 'success',
        emailsRead: 12,
        documentsIngested: 8,
        oneDriveFilesIngested: 3,
        recentErrors: [],
        pendingConfirmationLinks: [],
      }),
      pollAll: jest.fn().mockResolvedValue({ emailProcessed: 2, oneDriveProcessed: 1, errors: [] }),
    };

    controller = new InboundController(inboundServiceMock, graphServiceMock);
  });

  it('POST /inbound/upload invokes ingestDirectUpload', async () => {
    const file = { originalname: 'test.pdf' } as Express.Multer.File;
    const res = await controller.upload({ headers: {} } as any, { origin: 'UPLOAD' }, [file], { tenantId: 'tenant-1' } as any);
    expect(inboundServiceMock.ingestDirectUpload).toHaveBeenCalledWith('tenant-1', [file], 'UPLOAD', {});
    expect(res.processed).toBe(1);
  });

  it('POST /inbound/whatsapp invokes ingestWhatsApp', async () => {
    const body = { event: 'messages.upsert', data: {} };
    const res = await controller.whatsapp({ query: {} } as any, body, []);
    expect(inboundServiceMock.ingestWhatsApp).toHaveBeenCalledWith(body, undefined, undefined);
    expect(res.processed).toBe(1);
  });

  it('GET /inbound/status returns multichannel status and counts', async () => {
    const status = await controller.status();
    expect(status.channels.manualUpload.active).toBe(true);
    expect(status.channels.scanner.active).toBe(true);
    expect(status.channels.whatsApp.active).toBe(true);
    expect(status.channels.emailGraph.mailbox).toBe('financeiro@hotelequip.pt');
    expect(status.documents.recent24hCount).toBe(9);
  });

  it('POST /inbound/graph/sync triggers pollAll on MicrosoftGraphService', async () => {
    const res = await controller.triggerGraphSync();
    expect(graphServiceMock.pollAll).toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });
});
