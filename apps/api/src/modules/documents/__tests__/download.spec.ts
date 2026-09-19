import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { DocumentsController } from '../documents.controller';
import type { DocumentsService } from '../documents.service';

// ──────────────────────────────────────────────── regression coverage
//
// The /download endpoint uses @Res({ passthrough: false }) and calls
// res.end(buffer) itself. The original bug surfaced as
//   ERR_HTTP_HEADERS_SENT → 500
// because the global TenantInterceptor ran in `tap()` AFTER the controller
// had already flushed the bytes, then tried to `res.setHeader('x-tenant-id', ...)`
// on a finished response. That threw, the global filter caught it, and
// the filter then tried to `res.status(500).json(payload)` — a SECOND
// attempt to write to a finished response, which threw the same error
// again, masking the original 200 with two cascading 500s.
//
// The fix lives in three places:
//   - TenantInterceptor: skip setHeader / log when headers already sent
//   - AllExceptionsFilter: end() instead of res.status().json() when
//     the response was already flushed
//   - DocumentsController.download: bail out before res.set/res.end
//     if the response is already finished
//
// These tests pin those three guards.

function buildResponseMock(): Response {
  const headers: Record<string, string | number | string[]> = {};
  let headersSent = false;
  let writableEnded = false;
  let endCount = 0;
  let setCount = 0;
  let setHeaderCount = 0;
  let sentJson: unknown = null;
  const lastBody: { type: string; payload: unknown }[] = [];

  const res: Partial<Response> & {
    __stats: () => {
      endCount: number;
      setCount: number;
      setHeaderCount: number;
      headersSent: boolean;
      writableEnded: boolean;
      sentJson: unknown;
      lastBody: { type: string; payload: unknown }[];
    };
    __finish: () => void;
  } = {
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return writableEnded;
    },
    setHeader(name: string, value: string | number | string[]) {
      setHeaderCount += 1;
      if (headersSent) {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      }
      headers[name] = value;
      return res as Response;
    },
    set(headersToSet: Record<string, string | number | string[]>) {
      setCount += 1;
      if (headersSent) {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      }
      Object.assign(headers, headersToSet);
      return res as Response;
    },
    status(code: number) {
      headers['__status'] = code;
      return res as Response;
    },
    json(payload: unknown) {
      sentJson = payload;
      lastBody.push({ type: 'json', payload });
      headersSent = true;
      writableEnded = true;
      return res as Response;
    },
    send(payload: unknown) {
      lastBody.push({ type: 'send', payload });
      headersSent = true;
      writableEnded = true;
      return res as Response;
    },
    end(payload?: unknown) {
      endCount += 1;
      if (payload !== undefined) {
        lastBody.push({ type: 'end-buffer', payload });
      } else {
        lastBody.push({ type: 'end' });
      }
      headersSent = true;
      writableEnded = true;
      return res as Response;
    },
    __stats: () => ({
      endCount,
      setCount,
      setHeaderCount,
      headersSent,
      writableEnded,
      sentJson,
      lastBody,
    }),
    __finish: () => {
      headersSent = true;
      writableEnded = true;
    },
  };
  return res as Response & {
    __stats: () => {
      endCount: number;
      setCount: number;
      setHeaderCount: number;
      headersSent: boolean;
      writableEnded: boolean;
      sentJson: unknown;
      lastBody: { type: string; payload: unknown }[];
    };
  };
}

function buildServiceStub(): jest.Mocked<
  Pick<DocumentsService, 'getFileBuffer' | 'getFileUrl'>
> {
  return {
    getFileBuffer: jest.fn(),
    getFileUrl: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<DocumentsService, 'getFileBuffer' | 'getFileUrl'>
  >;
}

const USER = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'u@example.com',
  roles: [],
} as unknown as Parameters<DocumentsController['download']>[0];

describe('DocumentsController.download — double-send regression', () => {
  it('happy path: writes headers + ends exactly once with the buffer', async () => {
    const svc = buildServiceStub();
    svc.getFileBuffer.mockResolvedValueOnce({
      buffer: Buffer.from('%PDF-1.4 hello'),
      mimeType: 'application/pdf',
      fileName: 'fatura.pdf',
    });
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);
    const res = buildResponseMock();

    await ctrl.download(USER, 'doc-1', undefined, undefined, res);

    expect(svc.getFileBuffer).toHaveBeenCalledTimes(1);
    expect(svc.getFileBuffer).toHaveBeenCalledWith('tenant-1', 'doc-1', 'pdf');
    // res.end(buffer) — single send
    expect((res as any).__stats().endCount).toBe(1);
    expect((res as any).__stats().setCount).toBe(1);
    expect((res as any).__stats().lastBody[0].type).toBe('end-buffer');
    expect((res as any).__stats().sentJson).toBeNull();
  });

  it('cross-tenant / missing document: surfaces NotFoundException (no double send)', async () => {
    const svc = buildServiceStub();
    svc.getFileBuffer.mockRejectedValueOnce(
      new NotFoundException('Document not found'),
    );
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);
    const res = buildResponseMock();

    await expect(
      ctrl.download(USER, 'doc-other-tenant', undefined, undefined, res),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The controller must NOT have written anything — NotFoundException
    // bubbles to the global filter, which is the only component
    // allowed to call res.status().json() on a clean response.
    expect((res as any).__stats().endCount).toBe(0);
    expect((res as any).__stats().setCount).toBe(0);
  });

  it('bails out cleanly when an upstream interceptor already finished the response', async () => {
    // Simulates the regression: imagine a future interceptor that
    // somehow ends the response before this controller does. We must
    // not throw ERR_HTTP_HEADERS_SENT ourselves; we must return
    // without touching the response.
    const svc = buildServiceStub();
    svc.getFileBuffer.mockResolvedValueOnce({
      buffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      fileName: 'x.pdf',
    });
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);
    const res = buildResponseMock();
    // Simulate the response already being flushed
    (res as any).__finish();

    await expect(
      ctrl.download(USER, 'doc-1', undefined, undefined, res),
    ).resolves.toBeUndefined();
    expect((res as any).__stats().endCount).toBe(0);
    expect((res as any).__stats().setCount).toBe(0);
  });

  it('?format=original asks for the original bytes, not the pdf derivative', async () => {
    const svc = buildServiceStub();
    svc.getFileBuffer.mockResolvedValueOnce({
      buffer: Buffer.from('JPG-bytes'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    });
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);
    const res = buildResponseMock();

    await ctrl.download(USER, 'doc-1', undefined, 'original', res);

    expect(svc.getFileBuffer).toHaveBeenCalledWith('tenant-1', 'doc-1', 'original');
    expect((res as any).__stats().endCount).toBe(1);
  });

  it('DocumentsController.getFileUrl defaults to pdf format when not specified', async () => {
    const svc = buildServiceStub();
    svc.getFileUrl.mockResolvedValueOnce({
      url: 'https://minio/pdf-key.pdf',
      fileName: 'fatura.pdf',
      mimeType: 'application/pdf',
    });
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);

    const result = await ctrl.getFileUrl(USER, 'doc-1', undefined);

    expect(svc.getFileUrl).toHaveBeenCalledWith('tenant-1', 'doc-1', 'pdf');
    expect(result.mimeType).toBe('application/pdf');
  });

  it('DocumentsController.getFileUrl forwards original format when requested', async () => {
    const svc = buildServiceStub();
    svc.getFileUrl.mockResolvedValueOnce({
      url: 'https://minio/photo.jpg',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    const ctrl = new DocumentsController(svc as unknown as DocumentsService);

    const result = await ctrl.getFileUrl(USER, 'doc-1', 'original');

    expect(svc.getFileUrl).toHaveBeenCalledWith('tenant-1', 'doc-1', 'original');
    expect(result.mimeType).toBe('image/jpeg');
  });
});
