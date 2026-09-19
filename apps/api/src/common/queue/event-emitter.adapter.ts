import { Injectable, Logger } from '@nestjs/common';
// eventemitter2 is the underlying library that `@nestjs/event-emitter`
// re-exports. Importing it directly (instead of the Nest wrapper)
// keeps us on the CJS entry point — the 12.x Nest package dropped CJS,
// which breaks the Jest/ts-jest runner. Same surface area we use
// (on / emitAsync / removeAllListeners).
import { EventEmitter2 } from 'eventemitter2';
import type { QueueAdapter, QueueHandler } from './queue-adapter.interface';

/**
 * EventEmitterAdapter — in-process queue (default in dev/CI).
 *
 * Wraps EventEmitter2 with two additions on top of the library
 * defaults:
 *
 *   1. `publish()` is async and resolves only after every handler
 *      settles. `EventEmitter2.emitAsync` already does this; we
 *      forward to it for symmetry with the BullMQ adapter.
 *
 *   2. A handler that throws does NOT crash the publisher. We log the
 *      error and let the other subscribers still run. The contract
 *      is "best-effort delivery with isolated failures" — same shape
 *      the BullMQ adapter gives you (a failed job is retried, not
 *      allowed to derail the next job in the same batch).
 *
 * Caveat: this driver is NOT distributed. Every pod has its own
 * queue, so a publish on pod A is invisible to pod B. That's why
 * QUEUE_DRIVER=bullmq is the only safe choice in production.
 */
@Injectable()
export class EventEmitterAdapter implements QueueAdapter {
  readonly driver = 'eventemitter' as const;
  private readonly logger = new Logger(EventEmitterAdapter.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish(topic: string, payload: unknown): Promise<void> {
    try {
      // emitAsync returns true if every listener resolved, false if at
      // least one threw. Either way we resolve — the handler is
      // wrapped to swallow its own errors.
      await this.emitter.emitAsync(topic, payload);
    } catch (err) {
      this.logger.error(
        `[publish] topic=${topic} threw: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  subscribe(topic: string, handler: QueueHandler): void {
    this.emitter.on(topic, async (payload: unknown) => {
      try {
        await handler(payload);
      } catch (err) {
        this.logger.error(
          `[subscribe] topic=${topic} handler threw: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    });
  }

  subscribeBatch(topics: readonly string[], handler: QueueHandler): void {
    for (const topic of topics) {
      this.subscribe(topic, handler);
    }
  }
}
