import { EventEmitter } from 'events';
import type { PoolClient } from 'pg';

export type OutboxAggregateType =
  | 'product'
  | 'customer'
  | 'gst_invoice'
  | 'normal_bill'
  | 'quotation'
  | 'supplier'
  | 'expense';

export interface OutboxEnqueueInput {
  aggregateType: OutboxAggregateType;
  aggregateId: string | number;
  eventType: string;
  businessDate?: string | null;
  sourceVersion?: number;
  payload?: Record<string, unknown>;
}

const outboxEventsEmitter = new EventEmitter();
outboxEventsEmitter.setMaxListeners(20);

const OUTBOX_COMMITTED_EVENT = 'outbox:committed';

/**
 * Appends an outbox event strictly inside the caller's active PostgreSQL transaction.
 * If the caller rolls back the transaction, this outbox event is rolled back atomically.
 */
export async function enqueueOutboxEvent(
  client: PoolClient,
  input: OutboxEnqueueInput
): Promise<void> {
  const aggregateId = String(input.aggregateId);
  const sourceVersion =
    typeof input.sourceVersion === 'number' && Number.isFinite(input.sourceVersion)
      ? Math.max(1, Math.trunc(input.sourceVersion))
      : Date.now();
  const serializedPayload = JSON.stringify(input.payload || {});

  await client.query(
    `INSERT INTO app_outbox_events (
       aggregate_type,
       aggregate_id,
       event_type,
       payload,
       source_version,
       business_date,
       status,
       next_attempt_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', NOW(), NOW(), NOW())`,
    [
      input.aggregateType,
      aggregateId,
      input.eventType,
      serializedPayload,
      sourceVersion,
      input.businessDate ?? null,
    ]
  );


  // Transactional PostgreSQL notification for distributed outbox workers (fires strictly on COMMIT)
  await client.query("SELECT pg_notify('app_outbox_events', $1)", [aggregateId]);
}

/**
 * Signals the in-process outbox worker immediately after PostgreSQL COMMIT succeeds.
 * Does NOT run any polling timer when the system is idle.
 */
export function notifyOutboxCommitted(): void {
  outboxEventsEmitter.emit(OUTBOX_COMMITTED_EVENT);
}

export function onOutboxCommitted(listener: () => void): () => void {
  outboxEventsEmitter.on(OUTBOX_COMMITTED_EVENT, listener);
  return () => {
    outboxEventsEmitter.off(OUTBOX_COMMITTED_EVENT, listener);
  };
}
