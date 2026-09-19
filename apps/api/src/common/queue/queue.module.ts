import { Module, type DynamicModule } from '@nestjs/common';
import { EventEmitter2 } from 'eventemitter2';
import { BullmqAdapter } from './bullmq.adapter';
import { EventEmitterAdapter } from './event-emitter.adapter';
import { QUEUE_ADAPTER, type QueueAdapter } from './queue-adapter.interface';

/**
 * QueueModule — wires the QueueAdapter symbol to one of the two
 * driver implementations based on `QUEUE_DRIVER` env.
 *
 *   - `eventemitter` (default) — in-process, zero infra. Dev/CI only.
 *   - `bullmq` — Redis-backed, with retries + DLQ. Required in any
 *     environment where more than one replica is running.
 *
 * Both drivers ship unconditionally so a single `pnpm build` produces
 * a binary that can run with either driver — no separate dist per env.
 */
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    const driver = (process.env.QUEUE_DRIVER ?? 'eventemitter').toLowerCase();
    const useBullmq = driver === 'bullmq';

    return {
      module: QueueModule,
      imports: [],
      providers: useBullmq
        ? [
            BullmqAdapter,
            {
              provide: QUEUE_ADAPTER,
              useExisting: BullmqAdapter,
            },
          ]
        : [
            {
              provide: EventEmitter2,
              useFactory: () =>
                new EventEmitter2({
                  wildcard: true,
                  maxListeners: 100,
                }),
            },
            EventEmitterAdapter,
            {
              provide: QUEUE_ADAPTER,
              useExisting: EventEmitterAdapter,
            },
          ],
      exports: useBullmq
        ? [QUEUE_ADAPTER, BullmqAdapter]
        : [QUEUE_ADAPTER, EventEmitterAdapter, EventEmitter2],
      global: true,
    };
  }
}
