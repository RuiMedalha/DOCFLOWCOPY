/**
 * QueueAdapter — uniform publish/subscribe abstraction over a backing
 * queue. Two drivers ship today:
 *
 *   - EventEmitterAdapter — in-process FIFO. Dev/CI default. NOT
 *     distributed — every pod has its own queue. Documented limitation
 *     in the queue module's README.
 *
 *   - BullmqAdapter — Redis-backed. Production driver. Pulls jobs
 *     through BullMQ with retries + DLQ. Failures are visible across
 *     pods.
 *
 * The contract is narrow on purpose — anything the document pipeline
 * needs beyond publish/subscribe (delays, priorities, batching) is a
 * deliberate non-goal here. When we grow, we grow behind the symbol.
 *
 * Driver selection is runtime via QUEUE_DRIVER env; the QueueModule
 * factory picks the implementation accordingly.
 */

export const QUEUE_ADAPTER = Symbol('QUEUE_ADAPTER');

/**
 * A handler receives the raw payload as published. Handlers MUST be
 * idempotent — the adapter will not dedup. Use the deterministic
 * jobId in the BullMQ adapter (and any in-memory set in the EE
 * adapter) to make retries safe at the application layer.
 */
export type QueueHandler = (payload: unknown) => Promise<void> | void;

export interface QueueAdapter {
  /** Driver label used in logs and telemetry. */
  readonly driver: 'eventemitter' | 'bullmq';

  /**
   * Publish `payload` on `topic`. The adapter is responsible for any
   * retry/DLQ wiring specific to its driver. MUST never throw on
   * transient errors — caller already wraps in try/catch.
   */
  publish(topic: string, payload: unknown): Promise<void>;

  /**
   * Subscribe a handler to a single topic. Multiple subscriptions on
   * the same topic are allowed — every subscriber fires in
   * registration order.
   */
  subscribe(topic: string, handler: QueueHandler): void;

  /**
   * Convenience: bind one handler to many topics. Implemented as a
   * loop over `subscribe` so subscribers on individual topics still
   * fire alongside a batch subscription.
   */
  subscribeBatch(topics: readonly string[], handler: QueueHandler): void;
}
