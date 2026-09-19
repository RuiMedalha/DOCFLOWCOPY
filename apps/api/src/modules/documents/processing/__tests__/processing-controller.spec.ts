import { NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EMPTY } from 'rxjs';
import { ProcessingController } from '../processing.controller';
import { ProcessingEventsStore } from '../processing-events-store.service';

describe('ProcessingController tenant-scoped SSE', () => {
  const events = { stream: jest.fn(() => EMPTY) } as unknown as ProcessingEventsStore;
  const jwt = { verify: jest.fn() } as unknown as JwtService;
  const request = (tenantId: string) => ({
    user: { tenantId },
    on: jest.fn(),
  }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('opens a stream only after finding the document in the caller tenant', async () => {
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue({ id: 'doc-1' }) } };
    const controller = new ProcessingController(events, jwt, prisma as any);

    await controller.processingStream('doc-1', undefined, request('tenant-A'));

    expect(prisma.document.findFirst).toHaveBeenCalledWith({
      where: { id: 'doc-1', tenantId: 'tenant-A' },
      select: { id: true },
    });
    expect(events.stream).toHaveBeenCalledWith('tenant-A', 'doc-1');
  });

  it('does not create a cross-tenant stream for a guessed document id', async () => {
    const prisma = { document: { findFirst: jest.fn().mockResolvedValue(null) } };
    const controller = new ProcessingController(events, jwt, prisma as any);

    await expect(
      controller.processingStream('tenant-b-document', undefined, request('tenant-A')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(events.stream).not.toHaveBeenCalled();
  });
});
