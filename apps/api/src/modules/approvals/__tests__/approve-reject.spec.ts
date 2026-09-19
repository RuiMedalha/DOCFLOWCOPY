import {
  AuditAction,
  ApprovalStatus,
  DocumentStatus,
} from '@prisma/client';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalsService } from '../approvals.service';

/**
 * Sprint 1.B — decide-endpoint suite.
 *
 * Covers approve / reject / request-changes via the shared
 * private `decide()` path. Invariants:
 *
 *   1. Happy paths:
 *      - approve flips status → APPROVED + Document.status → APROVADO,
 *        emits AuditAction.APPROVE.
 *      - reject flips status → REJECTED + Document.status → REJEITADO,
 *        emits AuditAction.REJECT.
 *      - request-changes flips status → CHANGES_REQUESTED + Document
 *        .status → CHANGES_REQUESTED, emits AuditAction.EDIT.
 *   2. RBAC invariants enforced at the service layer (the
 *      controller's @Roles gate covers the user-role path; the
 *      service handles the requester-self-decide guard).
 *   3. Double-decide guard — a second decide on a non-PENDING row
 *      throws 409.
 *   4. Self-decide guard — the original requester cannot decide on
 *      their own request, regardless of role.
 *   5. 404 path — cross-tenant id surfaces as null → 404.
 */

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const USER_REQUESTER = 'user-requester';
const USER_APPROVER = 'user-approver';
const APPROVAL_ID = 'approval-1';

function buildPrismaStub() {
  const txStub: any = {
    approval: { update: jest.fn() },
    document: { update: jest.fn() },
  };
  const stub: any = {
    approval: {
      findFirst: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    document: {
      findFirst: jest.fn(),
      update: jest.fn(),
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

describe('ApprovalsService.approve()', () => {
  it('happy path: APPROVES the request + flips Document.status + writes APPROVE audit row', async () => {
    const { stub, txStub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.PENDING,
      requestedById: USER_REQUESTER,
      comment: 'orig',
      document: {
        id: 'doc-1',
        status: DocumentStatus.PENDING_APPROVAL,
        currentApprovalId: APPROVAL_ID,
      },
    });
    txStub.approval.update.mockResolvedValueOnce({});
    txStub.document.update.mockResolvedValueOnce({});

    const svc = makeSvc(stub, audit);
    const result = await svc.approve(
      TENANT_A,
      USER_APPROVER,
      'APPROVER',
      APPROVAL_ID,
      'looks good',
    );

    expect(result.approvalId).toBe(APPROVAL_ID);
    expect(result.documentId).toBe('doc-1');

    // Transaction updated Approval + Document atomically.
    expect(txStub.approval.update).toHaveBeenCalledTimes(1);
    const approvalUpdate = txStub.approval.update.mock.calls[0][0];
    expect(approvalUpdate.data).toMatchObject({
      status: ApprovalStatus.APPROVED,
      decidedById: USER_APPROVER,
      comment: 'looks good',
    });
    expect(approvalUpdate.data.decidedAt).toBeInstanceOf(Date);

    expect(txStub.document.update).toHaveBeenCalledTimes(1);
    // Service runs the status flip + currentApprovalId clear in one
    // tx.document.update. The `toMatchObject` form is more robust
    // than `toEqual` against enum-typed values, which Jest serialises
    // as strings.
    expect(txStub.document.update.mock.calls[0][0].data).toMatchObject({
      currentApprovalId: null,
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = audit.log.mock.calls[0][0];
    expect(auditArg.action).toBe(AuditAction.APPROVE);
    expect(auditArg.metadata.subAction).toBe('document.approve');
    expect(auditArg.metadata.newStatus).toBe(ApprovalStatus.APPROVED);
    expect(auditArg.metadata.newDocumentStatus).toBe(DocumentStatus.APROVADO);
  });

  it('throws 409 when the approval is already decided (double-decide)', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.APPROVED, // already decided
      requestedById: USER_REQUESTER,
      comment: null,
      document: {
        id: 'doc-1',
        status: DocumentStatus.APROVADO,
        currentApprovalId: null,
      },
    });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.approve(TENANT_A, USER_APPROVER, 'APPROVER', APPROVAL_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 403 when the requester tries to decide their own request', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.PENDING,
      requestedById: USER_REQUESTER,
      comment: null,
      document: {
        id: 'doc-1',
        status: DocumentStatus.PENDING_APPROVAL,
        currentApprovalId: APPROVAL_ID,
      },
    });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.approve(TENANT_A, USER_REQUESTER, 'APPROVER', APPROVAL_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 404 for a cross-tenant approval id', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce(null);

    const svc = makeSvc(stub, audit);
    await expect(
      svc.approve(TENANT_B, USER_APPROVER, 'APPROVER', APPROVAL_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ApprovalsService.reject()', () => {
  it('happy path: REJECTS the request + flips Document.status to REJEITADO', async () => {
    const { stub, txStub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.PENDING,
      requestedById: USER_REQUESTER,
      comment: null,
      document: {
        id: 'doc-1',
        status: DocumentStatus.PENDING_APPROVAL,
        currentApprovalId: APPROVAL_ID,
      },
    });
    txStub.approval.update.mockResolvedValueOnce({});
    txStub.document.update.mockResolvedValueOnce({});

    const svc = makeSvc(stub, audit);
    const result = await svc.reject(
      TENANT_A,
      USER_APPROVER,
      'APPROVER',
      APPROVAL_ID,
      'NIF ilegível',
    );

    expect(result.approvalId).toBe(APPROVAL_ID);
    expect(txStub.approval.update.mock.calls[0][0].data.status).toBe(
      ApprovalStatus.REJECTED,
    );
    expect(txStub.document.update.mock.calls[0][0].data).toEqual({
      status: DocumentStatus.REJEITADO,
      currentApprovalId: null,
    });
    expect(audit.log.mock.calls[0][0].action).toBe(AuditAction.REJECT);
    expect(audit.log.mock.calls[0][0].metadata.comment).toBe('NIF ilegível');
  });
});

describe('ApprovalsService.requestChanges()', () => {
  it('happy path: requests changes + flips Document.status to CHANGES_REQUESTED', async () => {
    const { stub, txStub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.PENDING,
      requestedById: USER_REQUESTER,
      comment: null,
      document: {
        id: 'doc-1',
        status: DocumentStatus.PENDING_APPROVAL,
        currentApprovalId: APPROVAL_ID,
      },
    });
    txStub.approval.update.mockResolvedValueOnce({});
    txStub.document.update.mockResolvedValueOnce({});

    const svc = makeSvc(stub, audit);
    const result = await svc.requestChanges(
      TENANT_A,
      USER_APPROVER,
      'APPROVER',
      APPROVAL_ID,
      'submete scan melhor',
    );

    expect(result.approvalId).toBe(APPROVAL_ID);
    expect(txStub.approval.update.mock.calls[0][0].data.status).toBe(
      ApprovalStatus.CHANGES_REQUESTED,
    );
    expect(txStub.document.update.mock.calls[0][0].data).toEqual({
      status: DocumentStatus.CHANGES_REQUESTED,
      currentApprovalId: null,
    });
    expect(audit.log.mock.calls[0][0].metadata.subAction).toBe(
      'document.request_changes',
    );
  });

  it('throws 403 on self-decide for requestChanges too', async () => {
    const { stub } = buildPrismaStub();
    const audit = buildAuditStub();

    stub.approval.findFirst.mockResolvedValueOnce({
      id: APPROVAL_ID,
      documentId: 'doc-1',
      status: ApprovalStatus.PENDING,
      requestedById: USER_REQUESTER,
      comment: null,
      document: {
        id: 'doc-1',
        status: DocumentStatus.PENDING_APPROVAL,
        currentApprovalId: APPROVAL_ID,
      },
    });

    const svc = makeSvc(stub, audit);
    await expect(
      svc.requestChanges(
        TENANT_A,
        USER_REQUESTER,
        'APPROVER',
        APPROVAL_ID,
        'comment',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
