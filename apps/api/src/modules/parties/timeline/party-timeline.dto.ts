import { ApiProperty } from '@nestjs/swagger';

/**
 * Discriminated union of timeline events. The `type` field is the
 * discriminator; downstream clients use it to switch on icon / colour
 * without inspecting the rest of the payload.
 */
export type TimelineEventType =
  | 'audit'
  | 'payment'
  | 'iban_change'
  | 'document_approved';

export interface TimelineEventBase {
  id: string;
  type: TimelineEventType;
  at: string; // ISO timestamp
}

export interface AuditTimelineEvent extends TimelineEventBase {
  type: 'audit';
  action: string;
  userId: string | null;
  metadata: unknown;
}

export interface PaymentTimelineEvent extends TimelineEventBase {
  type: 'payment';
  amount: string | null;
  status: string;
  documentId: string;
  // Security fix-up (Sprint G review §A1): fileKey intentionally OMITTED.
  // fileKey is the on-disk storage path (e.g. `tenants/<id>/<year>/<month>/<id>.pdf`)
  // and exposing it leaks the tenant's folder layout. The UI only needs
  // `docNumber` as the human-readable label — same convention as the
  // existing DocumentsModule responses.
  document: { id: string; docNumber: string | null } | null;
}

export interface IbanChangeTimelineEvent extends TimelineEventBase {
  type: 'iban_change';
  oldIban: string | null;
  newIban: string;
  verified: boolean;
  changedById: string | null;
}

export interface DocumentApprovedTimelineEvent extends TimelineEventBase {
  type: 'document_approved';
  documentId: string;
  fileName: string;
  docNumber: string | null;
  approvedById: string | null;
}

export type TimelineEvent =
  | AuditTimelineEvent
  | PaymentTimelineEvent
  | IbanChangeTimelineEvent
  | DocumentApprovedTimelineEvent;

export class TimelineListResponse {
  @ApiProperty({
    description: 'Events sorted by timestamp desc',
    type: 'array',
  })
  items: TimelineEvent[];

  @ApiProperty({
    description:
      'Cursor for the next page — opaque, base64 of the last returned timestamp + id composite. Null when no more pages.',
    nullable: true,
  })
  nextCursor: string | null;
}
