import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { ApprovalStatus } from '@prisma/client';

/**
 * Approval workflow DTOs.
 *
 * The wire shape mirrors the brief's 5 endpoints. Every body
 * carries an optional `comment` (mandatory for `reject` and
 * `request-changes` — the controller enforces it as a 400).
 *
 * Approval listing (`GET /approvals?status=...`) accepts a
 * closed enum so a misspelled status returns 400 instead of a
 * silent empty result.
 */

export const APPROVAL_STATUSES: ApprovalStatus[] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'WITHDRAWN',
];

/** Body for `POST /api/v1/documents/:id/request-approval`. */
export class RequestApprovalDto {
  @ApiPropertyOptional({
    description: 'Optional comment from the requester (free text, ≤ 1000 chars).',
    example: 'Documento pronto para revisão — fornecedor verificado.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Common base for the three decide endpoints. */
class DecideBaseDto {
  @ApiPropertyOptional({
    description: 'Decision comment (free text).',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

/** Body for `POST /api/v1/approvals/:id/approve`. */
export class ApproveApprovalDto extends DecideBaseDto {}

/**
 * Body for `POST /api/v1/approvals/:id/reject` — comment is
 * mandatory per the brief. The controller surfaces a 400 when
 * the comment is missing or empty so the UI gets a clean error
 * instead of a silent no-op.
 */
export class RejectApprovalDto {
  @ApiProperty({
    description: 'Rejection reason (mandatory).',
    example: 'Total não bate com a guia de transporte.',
    maxLength: 1000,
  })
  @IsString()
  @MaxLength(1000)
  comment!: string;
}

/** Body for `POST /api/v1/approvals/:id/request-changes` — comment mandatory. */
export class RequestChangesDto {
  @ApiProperty({
    description: 'What needs to change (mandatory).',
    example: 'NIF ilegível — submete scan de melhor qualidade.',
    maxLength: 1000,
  })
  @IsString()
  @MaxLength(1000)
  comment!: string;
}

/** Query string for `GET /api/v1/approvals`. */
export class ListApprovalsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by status. Omitted = all statuses.',
    enum: APPROVAL_STATUSES,
    example: 'PENDING',
  })
  @IsOptional()
  @IsString()
  @IsIn(APPROVAL_STATUSES as unknown as string[])
  status?: ApprovalStatus;
}

/** Response shape for the listing endpoint. */
export class ApprovalListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty({ description: 'Document number or fileName for the link row.' })
  documentLabel!: string;
  @ApiProperty() status!: ApprovalStatus;
  @ApiProperty() requestedById!: string;
  @ApiPropertyOptional() requestedByName?: string;
  @ApiPropertyOptional() decidedById?: string | null;
  @ApiPropertyOptional() decidedByName?: string | null;
  @ApiPropertyOptional() decidedAt?: string | null;
  @ApiPropertyOptional() comment?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Document supplier name (for the list row).' })
  supplierName?: string | null;
  @ApiPropertyOptional({ description: 'Document total (for the list row).' })
  totalAmount?: number | null;
}

/**
 * Helper used by the controller to wrap raw Approval rows + their
 * related Document + User metadata into the list shape. Keeps the
 * controller-side mapping out of the service so the service can
 * stay Prisma-shaped.
 */
export function toListItem(row: {
  approval: {
    id: string;
    tenantId: string;
    documentId: string;
    status: ApprovalStatus;
    requestedById: string;
    decidedById: string | null;
    decidedAt: Date | null;
    comment: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  document: {
    docNumber?: string | null;
    fileName?: string | null;
    supplier?: string | null;
    total?: { toString(): string } | number | null;
  };
  requestedBy: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
}): ApprovalListItemDto {
  const totalRaw = row.document.total as { toString(): string } | number | null | undefined;
  let totalAmount: number | null = null;
  if (typeof totalRaw === 'number') totalAmount = totalRaw;
  else if (totalRaw && typeof (totalRaw as { toString(): string }).toString === 'function') {
    const n = Number((totalRaw as { toString(): string }).toString());
    if (Number.isFinite(n)) totalAmount = n;
  }
  return {
    id: row.approval.id,
    tenantId: row.approval.tenantId,
    documentId: row.approval.documentId,
    documentLabel: row.document.docNumber ?? row.document.fileName ?? row.approval.documentId,
    status: row.approval.status,
    requestedById: row.approval.requestedById,
    requestedByName: row.requestedBy.name,
    decidedById: row.approval.decidedById,
    decidedByName: row.decidedBy?.name ?? null,
    decidedAt: row.approval.decidedAt?.toISOString() ?? null,
    comment: row.approval.comment,
    createdAt: row.approval.createdAt.toISOString(),
    updatedAt: row.approval.updatedAt.toISOString(),
    supplierName: row.document.supplier ?? null,
    totalAmount,
  };
}

/** Generic envelope for the history endpoint. */
export class ApprovalHistoryResponseDto {
  @ApiProperty({ type: [ApprovalListItemDto] })
  @Type(() => ApprovalListItemDto)
  items!: ApprovalListItemDto[];
}
