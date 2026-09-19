import { EventEmitterAdapter } from '../event-emitter.adapter';
// Import directly from eventemitter2 (CJS) — the @nestjs/event-emitter
// 12.x package is ESM-only and breaks the ts-jest runner.
import { EventEmitter2 } from 'eventemitter2';

/**
 * EventEmitterAdapter — in-process queue (default driver in dev/CI).
 *
 * Coverage:
 *   1. publish/subscribe — handler fires with payload
 *   2. subscribeBatch — single handler bound to multiple topics
 *   3. FIFO ordering within a single process
 *   4. Listener error is captured, publisher does not crash
 *   5. Multiple subscribers on the same topic all fire
 */
describe('EventEmitterAdapter (in-process queue)', () => {
  let emitter: EventEmitter2;
  let adapter: EventEmitterAdapter;

  beforeEach(() => {
    emitter = new EventEmitter2();
    adapter = new EventEmitterAdapter(emitter);
  });

  it('publishes to a single subscriber', async () => {
    const received: unknown[] = [];
    adapter.subscribe('document.received', (payload) => {
      received.push(payload);
    });

    await adapter.publish('document.received', { documentId: 'd1', tenantId: 't1' });
    expect(received).toEqual([{ documentId: 'd1', tenantId: 't1' }]);
  });

  it('subscribeBatch binds one handler to multiple topics', async () => {
    const received: Array<{ topic: string; payload: unknown }> = [];
    adapter.subscribeBatch(['document.extracted', 'document.enriched'], (payload) => {
      received.push({ topic: 'unknown', payload });
    });

    await adapter.publish('document.extracted', { ok: true });
    await adapter.publish('document.enriched', { partyId: 'p1' });
    expect(received).toHaveLength(2);
    expect(received[0].payload).toEqual({ ok: true });
    expect(received[1].payload).toEqual({ partyId: 'p1' });
  });

  it('preserves FIFO order across multiple publishes', async () => {
    const received: string[] = [];
    adapter.subscribe('document.received', (payload) => {
      received.push((payload as { id: string }).id);
    });

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await adapter.publish('document.received', { id: `seq-${i}` });
    }
    expect(received).toEqual(['seq-0', 'seq-1', 'seq-2', 'seq-3', 'seq-4']);
  });

  it('captures listener errors and does not crash the publisher', async () => {
    const good: unknown[] = [];
    adapter.subscribe('document.received', () => {
      throw new Error('listener boom');
    });
    adapter.subscribe('document.received', (payload) => {
      good.push(payload);
    });

    await expect(
      adapter.publish('document.received', { documentId: 'd1' }),
    ).resolves.toBeUndefined();
    expect(good).toEqual([{ documentId: 'd1' }]);
  });

  it('fires every subscriber for the same topic', async () => {
    const calls: string[] = [];
    adapter.subscribe('document.received', () => { calls.push('a'); });
    adapter.subscribe('document.received', () => { calls.push('b'); });
    adapter.subscribe('document.received', () => { calls.push('c'); });

    await adapter.publish('document.received', {});
    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('exposes driver label as "eventemitter"', () => {
    expect(adapter.driver).toBe('eventemitter');
  });
});
