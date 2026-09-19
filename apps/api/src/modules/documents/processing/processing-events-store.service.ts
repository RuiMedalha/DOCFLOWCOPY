import {
  Injectable,
  OnModuleDestroy,
} from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * Single in-memory event payload broadcast by the processing
 * pipeline. Stages (EXTRACTING, ENRICHING, ROUTING) emit
 * `processing.stage.completed`; the terminal stages emit either
 * `processing.completed` (success) or `processing.failed`.
 *
 * `payload` carries whatever the stage wants to expose — its content
 * is intentionally untyped here. The SSE controller decides what to
 * ship; this service just stores + forwards.
 */
export interface ProcessingStageEvent {
  documentId: string;
  tenantId: string;
  stage: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Maximum number of in-flight documents we hold subjects for. Once
 * the cap is reached, the OLDEST entry is dropped (its subscribers
 * see a `complete()` notification so they tear down cleanly).
 *
 * Defensive cap against memory leaks from SSE clients that forget
 * to close. Reduced from 1000 → 250 (security-audit M-17): 1000 was
 * above realistic concurrent doc throughput per pod (~10 MB of hot
 * memory per pod just for Subjects), and a burst that evicts the
 * oldest 1000 entries drops real subscribers on long-running docs.
 *
 * The controller layer (processing.controller) also enforces a
 * PER-DOC connection cap (5) so the global cap can't be hit by a
 * single attacker. The 250 ceiling is a backstop.
 */
const MAX_CONCURRENT_DOCS = 250;

/**
 * ProcessingEventsStore — the in-memory broadcaster that the SSE
 * controller wraps.
 *
 * One Subject per active document. Subscribers receive every event
 * the pipeline emits for that doc until they unsubscribe (or the
 * pipeline completes and `drop()` is called, which `complete()`s the
 * Subject). Multiple subscribers on the same doc all see every event.
 *
 * Terminal events (`processing.completed` / `processing.failed`)
 * also `complete()` the Subject — the SSE controller uses this to
 * know when to close the connection.
 *
 * Eviction policy is LEAST-RECENTLY-EMITTED (security-audit M-17).
 * The previous FIFO on insertion order wasn't LRU — it dropped the
 * FIRST subscriber to subscribe, which is exactly the long-running
 * doc that nobody is touching right now. LRU keeps active subjects
 * alive even when many new docs arrive in a burst.
 */
@Injectable()
export class ProcessingEventsStore implements OnModuleDestroy {
  private readonly subjectsByDoc = new Map<string, Subject<ProcessingStageEvent>>();
  /**
   * Last-emission timestamp in ms (monotonic). Updated on every
   * emit(); used as the LRU key for eviction.
   */
  private readonly lastEmittedAt = new Map<string, number>();
  private nextTimestamp = 0;

  /**
   * Open (or reuse) the Subject for `documentId` and return an
   * Observable view. The Observable is hot — events emitted before
   * a given subscriber subscribes are NOT replayed.
   */
  stream(tenantId: string, documentId: string): Observable<ProcessingStageEvent> {
    const key = this.key(tenantId, documentId);
    let subject = this.subjectsByDoc.get(key);
    if (!subject) {
      subject = new Subject<ProcessingStageEvent>();
      this.subjectsByDoc.set(key, subject);
      this.lastEmittedAt.set(key, this.nextTimestamp++);
      this.evictIfOverCap();
    }
    return subject.asObservable();
  }

  /**
   * Broadcast an event to every active subscriber on `event.documentId`.
   * Emitting for a docId with no subscribers is a cheap no-op (the
   * Map lookup misses, nothing happens). Updates the LRU timestamp.
   */
  emit(event: ProcessingStageEvent): void {
    const key = this.key(event.tenantId, event.documentId);
    const subject = this.subjectsByDoc.get(key);
    if (!subject) return;
    subject.next(event);
    this.lastEmittedAt.set(key, this.nextTimestamp++);
    if (event.event === 'processing.completed' || event.event === 'processing.failed') {
      this.drop(event.tenantId, event.documentId);
    }
  }

  /**
   * Force-complete the Subject for `documentId` and remove it from
   * the map. Idempotent — calling twice for the same id is a no-op.
   */
  drop(tenantId: string, documentId: string): void {
    const key = this.key(tenantId, documentId);
    const subject = this.subjectsByDoc.get(key);
    if (!subject) return;
    subject.complete();
    this.subjectsByDoc.delete(key);
    this.lastEmittedAt.delete(key);
  }

  /**
   * Module teardown — complete every Subject so SSE controllers can
   * clean up. Subscribers' `complete()` callbacks fire synchronously.
   */
  onModuleDestroy(): void {
    for (const subject of this.subjectsByDoc.values()) {
      subject.complete();
    }
    this.subjectsByDoc.clear();
    this.lastEmittedAt.clear();
  }

  private evictIfOverCap(): void {
    if (this.subjectsByDoc.size <= MAX_CONCURRENT_DOCS) return;
    // LRU eviction: drop the entry with the smallest lastEmittedAt.
    // Ties break by insertion order (FIFO on equal LRU) which is the
    // usual Map.iteration behaviour.
    let lruKey: string | undefined;
    let lruTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of this.lastEmittedAt) {
      if (ts < lruTs) {
        lruTs = ts;
        lruKey = key;
      }
    }
    if (lruKey !== undefined) {
      const separator = lruKey.indexOf(':');
      this.drop(lruKey.slice(0, separator), lruKey.slice(separator + 1));
    }
  }

  private key(tenantId: string, documentId: string): string {
    return `${tenantId}:${documentId}`;
  }
}
