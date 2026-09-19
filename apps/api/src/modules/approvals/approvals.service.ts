import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStatus,
  AuditAction,
  DocumentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ApprovalListItemDto } from './dto/approval.dto';
import { toListItem } from './dto/approval.dto';

/**
 * ApprovalsService — Sprint 1.B invoice-approval workflow.
 *
 * Lifecycle:
 *   1. Operator calls `requestApproval(tenantId, userId, documentId,
 *      comment?)` → creates Approval(PENDING) and flips Document.status
 *      to PENDING_APPROVAL atomically. `Document.currentApprovalId`
 *      points to the new row.
 *   2. Approver/admin calls `approve | reject | requestChanges` →
 *      mutates the Approval row + Document.status atomically.
 *      Self-decide guard (403): the requester cannot decide on
 *      their own request, regardless of role.
 *   3. Listing endpoints serve tenant-scoped rows with Document +
 *      User metadata so the UI does not need a second round-trip
 *      per row.
 *
 * Audit invariants:
 *   - `document.request_approval` (CREATE) on every request.
 *   - `document.approve` / `document.reject` /
 *     `document.request_changes` (APPROVE/REJECT/EDIT) on every
 *     decision. SubAction + previousStatus + decisionComment
 *     carried so the trail is replayable.
 *
 * Concurrency:
 *   - Status flip + Approval mutation live in a single Prisma
 *     `$transaction` so a concurrent decide never lands on a
 *     half-updated Document row. Two simultaneous approvers will
 *     race on the Approval.status update — the second one will
 *     hit the 409 path because the row's status is no longer
 *     PENDING by the time the transaction opens.
 */

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── Request approval ────────────────────────────────────────────────

  /**
   * Open a new approval request for a document. Pre-conditions:
   *   - Document is owned by `tenantId` (404 otherwise).
   *   - Document has no other PENDING approval already open —
   *     a second concurrent request would race the same state
   *     machine so we refuse with 409 to keep the model clean.
   *   - Document.status is currently NOVO (the only state from
   *     which an approval can be opened per the brief). Any other
   *     status → 409.
   *
   * Tenant scoping: `findFirst({ where: { id, tenantId } })` so a
   * cross-tenant id surfaces as `null` → 404. We never trust a
   * body-supplied tenantId.
   */
  async requestApproval(
    tenantId: string,
    userId: string,
    documentId: string,
    comment?: string,
  ): Promise<{ approvalId: string; verifiedAt: string }> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: {
        id: true,
        status: true,
        currentApprovalId: true,
        supplierVerifiedAt: true,
      },
    });
    if (!doc) throw new NotFoundException('Document not found');

    if (doc.status !== DocumentStatus.NOVO) {
      throw new ConflictException(
        `Cannot request approval for a document in status ${doc.status}; current status must be NOVO`,
      );
    }
    if (!doc.supplierVerifiedAt) {
      throw new BadRequestException(
        'supplierVerifiedAt must be set before an approval can be requested (operator must review the supplier block first)',
      );
    }

    const existing = await this.prisma.approval.findFirst({
      where: {
        tenantId,
        documentId,
        status: ApprovalStatus.PENDING,
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `Document already has a pending approval (id=${existing.id})`,
      );
    }

    const { approval, verifiedAt } = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.approval.create({
          data: {
            tenantId,
            documentId,
            requestedById: userId,
            status: ApprovalStatus.PENDING,
            comment: comment ?? null,
          },
        });
        await tx.document.update({
          where: { id: documentId },
          data: {
            status: DocumentStatus.PENDING_APPROVAL,
            currentApprovalId: created.id,
          },
        });
        return {
          approval: created,
          verifiedAt: doc.supplierVerifiedAt ?? new Date(),
        };
      },
    );

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'document',
      entityId: documentId,
      metadata: {
        subAction: 'document.request_approval',
        approvalId: approval.id,
        comment: comment ?? null,
      } as Prisma.InputJsonValue,
    });

    return {
      approvalId: approval.id,
      verifiedAt: verifiedAt.toISOString(),
    };
  }

  // ─── Decide helpers ──────────────────────────────────────────────────

  private async decide(args: {
    tenantId: string;
    userId: string;
    approvalId: string;
    userRole: string;
    newStatus: ApprovalStatus;
    auditAction: AuditAction;
    auditSubAction: string;
    documentStatus: DocumentStatus;
    comment: string | null;
  }): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    const approval = await this.prisma.approval.findFirst({
      where: { id: args.approvalId, tenantId: args.tenantId },
      select: {
        id: true,
        documentId: true,
        status: true,
        requestedById: true,
        comment: true,
        document: {
          select: { id: true, status: true, currentApprovalId: true },
        },
      },
    });
    if (!approval) throw new NotFoundException('Approval not found');

    if (approval.status !== ApprovalStatus.PENDING) {
      throw new ConflictException(
        `Approval is already in status ${approval.status}; create a new approval request to retry`,
      );
    }

    if (approval.requestedById === args.userId) {
      throw new ForbiddenException(
        'You cannot decide on your own approval request — another approver must review it',
      );
    }

    const decidedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: args.newStatus,
          decidedById: args.userId,
          decidedAt,
          comment: args.comment ?? null,
        },
      });
      await tx.document.update({
        where: { id: approval.documentId },
        data: {
          status: args.documentStatus,
          currentApprovalId: null,
        },
      });
    });

    await this.audit.log({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.auditAction,
      entityType: 'document',
      entityId: approval.documentId,
      metadata: {
        subAction: args.auditSubAction,
        approvalId: approval.id,
        previousStatus: approval.status,
        newStatus: args.newStatus,
        previousDocumentStatus: approval.document.status,
        newDocumentStatus: args.documentStatus,
        comment: args.comment ?? null,
        userRole: args.userRole,
      } as Prisma.InputJsonValue,
    });

    return {
      approvalId: approval.id,
      documentId: approval.documentId,
      decidedAt: decidedAt.toISOString(),
    };
  }

  async approve(
    tenantId: string,
    userId: string,
    userRole: string,
    approvalId: string,
    comment?: string,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    return this.decide({
      tenantId,
      userId,
      approvalId,
      userRole,
      newStatus: ApprovalStatus.APPROVED,
      auditAction: AuditAction.APPROVE,
      auditSubAction: 'document.approve',
      documentStatus: DocumentStatus.APROVADO,
      comment: comment ?? null,
    });
  }

  async reject(
    tenantId: string,
    userId: string,
    userRole: string,
    approvalId: string,
    comment: string,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    return this.decide({
      tenantId,
      userId,
      approvalId,
      userRole,
      newStatus: ApprovalStatus.REJECTED,
      auditAction: AuditAction.REJECT,
      auditSubAction: 'document.reject',
      documentStatus: DocumentStatus.REJEITADO,
      comment,
    });
  }

  async requestChanges(
    tenantId: string,
    userId: string,
    userRole: string,
    approvalId: string,
    comment: string,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    return this.decide({
      tenantId,
      userId,
      approvalId,
      userRole,
      newStatus: ApprovalStatus.CHANGES_REQUESTED,
      auditAction: AuditAction.EDIT,
      auditSubAction: 'document.request_changes',
      documentStatus: DocumentStatus.CHANGES_REQUESTED,
      comment,
    });
  }

  // ─── Listing + history ───────────────────────────────────────────────

  async list(
    tenantId: string,
    filter: { status?: ApprovalStatus },
  ): Promise<ApprovalListItemDto[]> {
    const rows = await this.prisma.approval.findMany({
      where: {
        tenantId,
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        document: {
          select: { docNumber: true, fileName: true, supplier: true, total: true },
        },
        requestedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });
    return rows.map((row) =>
      toListItem({
        approval: row,
        document: row.document,
        requestedBy: row.requestedBy,
        decidedBy: row.decidedBy,
      }),
    );
  }

  async historyForDocument(
    tenantId: string,
    documentId: string,
  ): Promise<ApprovalListItemDto[]> {
    const rows = await this.prisma.approval.findMany({
      where: { tenantId, documentId },
      orderBy: { createdAt: 'desc' },
      include: {
        document: {
          select: { docNumber: true, fileName: true, supplier: true, total: true },
        },
        requestedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });
    return rows.map((row) =>
      toListItem({
        approval: row,
        document: row.document,
        requestedBy: row.requestedBy,
        decidedBy: row.decidedBy,
      }),
    );
  }

  // ─── Aggregate helpers ───────────────────────────────────────────────

  async pendingCount(tenantId: string): Promise<number> {
    return this.prisma.approval.count({
      where: { tenantId, status: ApprovalStatus.PENDING },
    });
  }
}
