import { AuditAction, ApprovalStatus, DocumentStatus } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalsService } from '../approvals.service';

/**
 * Sprint 1.B — request-approval suite.
 *
 * Covers the POST /documents/:id/request-approval endpoint and the
 * invariants it MUST hold:
 *
 *   1. Tenant ownership — cross-tenant id → 404, no row, no audit.
 *   2. Pre-condition: status === NOVO. Any other status → 409.
 *   3. Pre-condition: supplierVerifiedAt set. Missing → 400.
 *   4. Pre-condition: no existing PENDING approval. Otherwise → 409.
 *   5. Atomic: Approval insert + Document.status flip +
 *      currentApprovalId stamp happen in one Prisma transaction.
 *   6. Audit row tagged `document.request_approval` carrying the
 *      approvalId + comment (when supplied).
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_ID = 'user-1';
const DOC_ID = 'doc-1';

function buildPrismaStub() {
  const txStub: any = {
    approval: { create: jest.fn() },
    document: { update: jest.fn() },
  };
  const stub: any = {
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    approval: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(async (fn: any) => fn(txStub)),
  };
  return { stub, txStub };
}

function buildAuditStub() {
  return { log: jest.fn(async () => undefined) };
}

function makeSvc(prisma: any, audit: any) {
  return new ApprovalsService(prisma as any, audit as any);
}

describe('ApprovalsService.requestApproval()', () => {
  it('opens a pending approval + flips Document.status to PENDING_APPROVAL atomically', async () => {
    const { stub, txStub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: DocumentStatus.NOVO,
      currentApprovalId: null,
      supplierVerifiedAt: new Date('2026-09-08T10:00:00Z'),
    });
    stub.approval.findFirst.mockResolvedValueOnce(null); // no existing PENDING
    const createdApproval = {
      id: 'approval-1',
      tenantId: TENANT_A,
      documentId: DOC_ID,
      status: ApprovalStatus.PENDING,
      requestedById: USER_ID,
      decidedById: null,
      decidedAt: null,
      comment: 'pronto',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    txStub.approval.create.mockResolvedValueOnce(createdApproval);
    txStub.document.update.mockResolvedValueOnce({ id: DOC_ID });

    const svc = makeSvc(stub, audit);
    const result = await svc.requestApproval(TENANT_A, USER_ID, DOC_ID, 'pronto');

    expect(result.approvalId).toBe('approval-1');
    expect(typeof result.verifiedAt).toBe('string');

    // Transaction ran both ops in order.
    expect(txStub.approval.create).toHaveBeenCalledTimes(1);
    expect(txStub.document.update).toHaveBeenCalledTimes(1);
    const docUpdateArg = txStub.document.update.mock.calls[0][0];
    expect(docUpdateArg.data).toEqual({
      status: DocumentStatus.PENDING_APPROVAL,
      currentApprovalId: 'approval-1',
    });

    // Audit row emitted with the right subAction + comment.
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = audit.log.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_A,
      userId: USER_ID,
      action: AuditAction.CREATE,
      entityType: 'document',
      entityId: DOC_ID,
    });
    expect(auditArg.metadata.subAction).toBe('document.request_approval');
    expect(auditArg.metadata.approvalId).toBe('approval-1');
    expect(auditArg.metadata.comment).toBe('pronto');
  });

  it('throws 404 for a cross-tenant document id without writing anything', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.document.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(stub, audit);
    await expect(
      svc.requestApproval(TENANT_B, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(stub.approval.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('throws 400 when supplierVerifiedAt is not set', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: DocumentStatus.NOVO,
      currentApprovalId: null,
      supplierVerifiedAt: null,
    });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.requestApproval(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(stub.approval.create).not.toHaveBeenCalled();
  });

  it('throws 409 when the document is already past NOVO', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: DocumentStatus.EM_REVISAO,
      currentApprovalId: null,
      supplierVerifiedAt: new Date(),
    });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.requestApproval(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 409 when a PENDING approval already exists', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.document.findFirst.mockResolvedValueOnce({
      id: DOC_ID,
      status: DocumentStatus.NOVO,
      currentApprovalId: null,
      supplierVerifiedAt: new Date(),
    });
    stub.approval.findFirst.mockResolvedValueOnce({ id: 'existing-approval' });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.requestApproval(TENANT_A, USER_ID, DOC_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
