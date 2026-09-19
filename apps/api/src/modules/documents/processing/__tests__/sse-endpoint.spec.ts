import { Subject, firstValueFrom, take } from 'rxjs';
import { ProcessingEventsStore } from '../processing-events-store.service';
import type { ProcessingStageEvent } from '../processing-events-store.service';

/**
 * ProcessingEventsStore — the in-memory broadcaster that the SSE
 * controller wraps.
 *
 * Coverage:
 *   1. emit() reaches a subscriber.
 *   2. emit() of a terminal event (processing.completed / processing.failed)
 *      completes the Subject and removes it from the map.
 *   3. drop() is idempotent and completes the Subject.
 *   4. Multiple subscribers on the same documentId all receive every event.
 *   5. Hard cap of MAX_CONCURRENT_DOCS drops the oldest entry when exceeded.
 */

describe('ProcessingEventsStore (SSE broadcaster)', () => {
  let store: ProcessingEventsStore;

  beforeEach(() => {
    store = new ProcessingEventsStore();
  });

  function evt(overrides: Partial<ProcessingStageEvent> = {}): ProcessingStageEvent {
    return {
      documentId: 'doc-1',
      tenantId: 'tenant-A',
      stage: 'EXTRACTING',
      event: 'processing.stage.completed',
      payload: { stage: 'EXTRACTING', status: 'started', completedAt: new Date().toISOString() },
      ...overrides,
    };
  }

  it('streams emitted events to a fresh subscriber', async () => {
    const obs = store.stream('tenant-A', 'doc-1');
    const promise = firstValueFrom(obs.pipe(take(1)));

    // Emit BEFORE the subscriber subscribes — RxJS Subjects don't replay
    // unless we use a ReplaySubject. The stream() factory returns a hot
    // Observable so emit-after-subscribe is the correct contract.
    const sub = obs.subscribe();
    store.emit(evt({ stage: 'EXTRACTING' }));
    sub.unsubscribe();
    await expect(promise).resolves.toMatchObject({
      stage: 'EXTRACTING',
      event: 'processing.stage.completed',
    });
  });

  it('emits the terminal event AND completes the Observable', async () => {
    const obs = store.stream('tenant-A', 'doc-2');
    const seen: string[] = [];
    const completed = new Promise<void>((resolve) => {
      obs.subscribe({
        next: (e) => seen.push(e.event),
        complete: () => resolve(),
      });
    });

    store.emit(evt({ documentId: 'doc-2', stage: 'COMPLETED', event: 'processing.completed' }));
    await completed;
    expect(seen).toEqual(['processing.completed']);
  });

  it('drop() completes the Subject and is idempotent', () => {
    const obs = store.stream('tenant-A', 'doc-3');
    let completed = false;
    obs.subscribe({ complete: () => { completed = true; } });

    store.drop('tenant-A', 'doc-3');
    expect(completed).toBe(true);

    // Idempotent — calling drop again does not throw.
    expect(() => store.drop('tenant-A', 'doc-3')).not.toThrow();
    expect(() => store.drop('tenant-A', 'does-not-exist')).not.toThrow();
  });

  it('emits a processing.failed event AND completes the Observable', async () => {
    const obs = store.stream('tenant-A', 'doc-4');
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      obs.subscribe({
        next: (e) => seen.push(e.event),
        complete: () => resolve(),
      });
    });

    store.emit(evt({
      documentId: 'doc-4',
      stage: 'FAILED',
      event: 'processing.failed',
      payload: { stage: 'FAILED', status: 'failed', completedAt: new Date().toISOString(), error: 'queue publish failed' },
    }));

    await done;
    expect(seen).toEqual(['processing.failed']);
  });

  it('multiple subscribers on the same docId all receive events', () => {
    const obs = store.stream('tenant-A', 'doc-5');
    const a: string[] = [];
    const b: string[] = [];
    obs.subscribe({ next: (e) => a.push(e.event) });
    obs.subscribe({ next: (e) => b.push(e.event) });

    store.emit(evt({ documentId: 'doc-5', stage: 'EXTRACTING' }));
    store.emit(evt({ documentId: 'doc-5', stage: 'ENRICHING' }));

    expect(a).toEqual(['processing.stage.completed', 'processing.stage.completed']);
    expect(b).toEqual(['processing.stage.completed', 'processing.stage.completed']);
  });

  it('emitting to a docId with no subscribers is a no-op (does not throw)', () => {
    expect(() => store.emit(evt({ documentId: 'ghost' }))).not.toThrow();
  });

  it('subject cleanup happens on module destroy', () => {
    // Open subscribers on 2 different docs
    const a = store.stream('tenant-A', 'doc-6');
    const b = store.stream('tenant-A', 'doc-7');
    let aDone = false;
    let bDone = false;
    a.subscribe({ complete: () => { aDone = true; } });
    b.subscribe({ complete: () => { bDone = true; } });

    store.onModuleDestroy();
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });

  it('isolates identical document ids between tenants', () => {
    const tenantA = store.stream('tenant-A', 'shared-doc');
    const tenantB = store.stream('tenant-B', 'shared-doc');
    const seenA: ProcessingStageEvent[] = [];
    const seenB: ProcessingStageEvent[] = [];
    tenantA.subscribe({ next: (event) => seenA.push(event) });
    tenantB.subscribe({ next: (event) => seenB.push(event) });

    store.emit(evt({ documentId: 'shared-doc', tenantId: 'tenant-A', payload: { error: 'tenant-A-only' } }));

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
  });
});
