import { BullmqAdapter, DOCUMENT_PROCESSING_QUEUE } from '../bullmq.adapter';
import * as bullmq from 'bullmq';
import { DocumentProcessingStatus } from '@prisma/client';
import { ProcessingService } from '../../../modules/documents/processing/processing.service';
import { ProcessingEventsStore } from '../../../modules/documents/processing/processing-events-store.service';

/**
 * BullmqAdapter — Redis-backed queue.
 *
 * Redis is not provisioned in the dev box (verified at boot), so this
 * suite stubs the underlying Queue/Worker classes via Jest module mocks.
 * The point of the tests is the adapter's surface — publish/subscribe
 * wiring, jobId derivation, driver label — not the BullMQ internals
 * (those have their own integration suite in the BullMQ repo).
 */
type AnyHandler = (payload: unknown) => Promise<void> | void;

interface FakeQueue {
  add: jest.Mock;
  close: jest.Mock;
}

interface FakeWorker {
  on: jest.Mock;
  close: jest.Mock;
}

// Mock bullmq at the module level so redis is never required.
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockResolvedValue(undefined),
    })),
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock ioredis so the connection constructor never opens a socket.
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  }));
});

describe('BullmqAdapter (Redis-backed queue)', () => {
  let adapter: BullmqAdapter;
  let QueueCtor: jest.Mock;
  let WorkerCtor: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    QueueCtor = bullmq.Queue as unknown as jest.Mock;
    WorkerCtor = bullmq.Worker as unknown as jest.Mock;
    adapter = new BullmqAdapter();
    await adapter.onModuleInit();
  });

  afterEach(async () => {
    await adapter.onModuleDestroy();
  });

  it('exposes driver label as "bullmq"', () => {
    expect(adapter.driver).toBe('bullmq');
  });

  it('publishes a job onto the queue', async () => {
    await adapter.publish('document.received', { documentId: 'd1', tenantId: 't1' });

    // The Queue constructor was invoked with the right name and the
    // adapter's `add()` was called exactly once with our payload.
    
    expect(QueueCtor).toHaveBeenCalledWith(
      DOCUMENT_PROCESSING_QUEUE,
      expect.objectContaining({
        connection: expect.any(Object),
        defaultJobOptions: expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        }),
      }),
    );

    // Pull the Queue instance from the mock factory and assert `add`
    // was invoked with our topic + payload envelope.
    const queueInstance: FakeQueue = QueueCtor.mock.results[0].value;
    expect(queueInstance.add).toHaveBeenCalledTimes(1);
    const [jobName, envelope, opts] = queueInstance.add.mock.calls[0];
    expect(jobName).toBe('document.received');
    expect(envelope).toEqual({
      topic: 'document.received',
      payload: { documentId: 'd1', tenantId: 't1' },
    });
    expect(opts).toEqual({ jobId: expect.stringMatching(/^sh-[a-f0-9]{24}$/) });
  });

  it('derives deterministic jobId for the same payload', async () => {
    await adapter.publish('document.received', { documentId: 'd1', tenantId: 't1' });
    await adapter.publish('document.received', { documentId: 'd1', tenantId: 't1' });

    
    const queueInstance: FakeQueue = QueueCtor.mock.results[0].value;
    const id1 = queueInstance.add.mock.calls[0][2].jobId;
    const id2 = queueInstance.add.mock.calls[1][2].jobId;
    expect(id1).toBe(id2);
  });

  it('derives different jobId for different payloads', async () => {
    await adapter.publish('document.received', { documentId: 'd1' });
    await adapter.publish('document.received', { documentId: 'd2' });

    
    const queueInstance: FakeQueue = QueueCtor.mock.results[0].value;
    const id1 = queueInstance.add.mock.calls[0][2].jobId;
    const id2 = queueInstance.add.mock.calls[1][2].jobId;
    expect(id1).not.toBe(id2);
  });

  it('treats a BullMQ duplicate-jobId rejection as a no-op', async () => {
    // Re-build the adapter with a queue that throws EEXIST on every
    // publish, simulating a real BullMQ dedup conflict.
    
    QueueCtor.mockImplementationOnce(() => ({
      add: jest.fn().mockRejectedValue(new Error('jobId already exists')),
      close: jest.fn().mockResolvedValue(undefined),
    }));
    const dupAdapter = new BullmqAdapter();
    await dupAdapter.onModuleInit();

    await expect(
      dupAdapter.publish('document.received', { id: 'dup' }),
    ).resolves.toBeUndefined();

    await dupAdapter.onModuleDestroy();
  });

  it('propagates non-dedup queue errors', async () => {
    
    QueueCtor.mockImplementationOnce(() => ({
      add: jest.fn().mockRejectedValue(new Error('redis connection refused')),
      close: jest.fn().mockResolvedValue(undefined),
    }));
    const errAdapter = new BullmqAdapter();
    await errAdapter.onModuleInit();

    await expect(
      errAdapter.publish('document.received', { id: 'fresh' }),
    ).rejects.toThrow(/redis connection refused/);

    await errAdapter.onModuleDestroy();
  });

  it('subscribe/subscribeBatch register handlers for the worker to pick up', () => {
    const handler: AnyHandler = jest.fn();
    adapter.subscribeBatch(['document.received', 'document.extracted'], handler);
    adapter.subscribe('document.enriched', handler);

    // Inspect the internal handler map — the worker is mocked, so we
    // can't trigger a job here, but the contract is "one entry per topic".
    const map = adapter.handlersByTopic as Map<string, AnyHandler>;
    expect(map.size).toBe(3);
    expect(map.has('document.received')).toBe(true);
    expect(map.has('document.extracted')).toBe(true);
    expect(map.has('document.enriched')).toBe(true);
  });

  it('unwraps the BullMQ envelope before dispatching to the topic handler', async () => {
    const handler = jest.fn(async () => undefined);
    adapter.subscribe('document.routed', handler);
    const workerProcessor = WorkerCtor.mock.calls[0][1] as (job: { name: string; data: unknown }) => Promise<void>;
    const payload = { documentId: 'doc-1', tenantId: 'tenant-A', userId: 'user-1' };

    await workerProcessor({
      name: 'document.routed',
      data: { topic: 'document.routed', payload },
    });

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('does not unwrap EventEmitter-style raw payloads or mismatched envelopes', async () => {
    const handler = jest.fn(async () => undefined);
    adapter.subscribe('document.routed', handler);
    const workerProcessor = WorkerCtor.mock.calls[0][1] as (job: { name: string; data: unknown }) => Promise<void>;
    const rawPayload = { documentId: 'doc-1', tenantId: 'tenant-A' };

    await workerProcessor({ name: 'document.routed', data: rawPayload });
    await workerProcessor({ name: 'document.routed', data: { topic: 'other', payload: rawPayload } });

    expect(handler).toHaveBeenNthCalledWith(1, rawPayload);
    expect(handler).toHaveBeenNthCalledWith(2, { topic: 'other', payload: rawPayload });
  });

  it('drives document.routed through BullMQ to COMPLETED and the terminal SSE event', async () => {
    const events = new ProcessingEventsStore();
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const prisma = {
      document: {
        findFirst: jest.fn(async () => ({
          id: 'doc-1',
          tenantId: 'tenant-A',
          partyId: 'party-1',
          processingStatus: DocumentProcessingStatus.ROUTING,
          processingStartedAt: null,
          tenant: { settings: null },
        })),
        update,
      },
      $executeRaw: jest.fn(async () => undefined),
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    };
    const audit = { log: jest.fn(), logInTx: jest.fn() };
    const extraction = { enqueue: jest.fn() };
    const documents = { approve: jest.fn() };
    new ProcessingService(
      prisma as any,
      audit as any,
      events,
      extraction as any,
      documents as any,
      adapter,
    );
    const received: string[] = [];
    events.stream('tenant-A', 'doc-1').subscribe({ next: (event) => received.push(event.event) });
    const workerProcessor = WorkerCtor.mock.calls[0][1] as (job: { name: string; data: unknown }) => Promise<void>;

    await workerProcessor({
      name: 'document.routed',
      data: {
        topic: 'document.routed',
        payload: {
          documentId: 'doc-1',
          tenantId: 'tenant-A',
          userId: 'user-1',
          approved: false,
          newFileKey: null,
          partyId: 'party-1',
          completedAt: new Date().toISOString(),
        },
      },
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ processingStatus: DocumentProcessingStatus.COMPLETED }),
    }));
    expect(received).toEqual(['processing.completed']);
  });

  it('spawns a Worker on init and closes it on destroy', async () => {
    
    // Reset the mock so we can count calls cleanly (beforeEach already
    // created one Worker; this test wants the count relative to fresh).
    WorkerCtor.mockClear();
    QueueCtor.mockClear();

    const fresh = new BullmqAdapter();
    await fresh.onModuleInit();
    expect(WorkerCtor).toHaveBeenCalledTimes(1);

    const workerInstance: FakeWorker = WorkerCtor.mock.results[0].value;
    expect(workerInstance.on).toHaveBeenCalled();
    expect(workerInstance.close).not.toHaveBeenCalled();

    await fresh.onModuleDestroy();
    expect(workerInstance.close).toHaveBeenCalledTimes(1);
  });
});
