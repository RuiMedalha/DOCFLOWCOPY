import { DocumentStatus, AuditAction } from '@prisma/client';
import { SaftExportService } from '../saft-export.service';

/**
 * Sprint 1.C — SAF-T filter + audit invariants.
 *
 * Verifies:
 *   1. Only `APROVADO` documents enter the SAF-T.
 *   2. The `from`/`to` window narrows the result to docs with
 *      `docDate` inside the period.
 *   3. Every successful export logs `AuditAction.EXPORT` with
 *      `period` + `documentCount` + `hashChainHead` +
 *      `hashChainTail`.
 */

const TENANT_ID = 'tenant-A';
const NOW = new Date('2026-03-15T12:00:00Z');

function buildPrismaStub(documents: any[]) {
  return {
    tenant: {
      findFirst: jest.fn(async () => ({
        id: TENANT_ID,
        slug: 'demo',
        name: 'NOV OUSADO UNIPESSOAL LDA',
        nif: '515208566',
      })),
    },
    document: {
      findMany: jest.fn(async (args: any) => {
        // The service filters by status === APROVADO server-side,
        // but for the unit test we mimic that filtering here so
        // we can drive different inputs and see how the service
        // consumes them.
        const filtered = documents.filter((d) => {
          if (args?.where?.status && d.status !== args.where.status) return false;
          if (args?.where?.docDate) {
            const date = d.docDate instanceof Date ? d.docDate : new Date(d.docDate);
            if (args.where.docDate.gte && date < args.where.docDate.gte) return false;
            if (args.where.docDate.lte && date > args.where.docDate.lte) return false;
          }
          if (args?.where?.deletedAt !== undefined) {
            // `null` in the where means "row.deletedAt must be null".
            // Match by `d.deletedAt == null` so absent fields
            // (undefined) still pass — matches Prisma's own
            // null-handling for nullable columns.
            if (args.where.deletedAt === null) {
              if (d.deletedAt != null) return false;
            } else if (d.deletedAt !== args.where.deletedAt) {
              return false;
            }
          }
          if (args?.where?.tenantId && d.tenantId !== args.where.tenantId) return false;
          return true;
        });
        return filtered;
      }),
    },
    $transaction: jest.fn(async () => null),
  };
}

function makeService(prisma: any, audit: any): SaftExportService {
  return new SaftExportService(prisma, audit);
}

describe('SaftExportService — filters', () => {
  it('only forwards APPROVED documents to the SAF-T (others are filtered server-side)', async () => {
    const documents = [
      { id: 'd1', tenantId: TENANT_ID, docNumber: 'FT 1', atcud: 'A1', docDate: new Date('2026-03-01'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 100, taxAmount: 23, total: 123, currency: 'EUR', metadata: {} },
      { id: 'd2', tenantId: TENANT_ID, docNumber: 'FT 2', atcud: 'A2', docDate: new Date('2026-03-02'), type: 'FATURA_RECEBIDA', status: DocumentStatus.NOVO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 200, taxAmount: 46, total: 246, currency: 'EUR', metadata: {} },
      { id: 'd3', tenantId: TENANT_ID, docNumber: 'FT 3', atcud: 'A3', docDate: new Date('2026-03-03'), type: 'FATURA_RECEBIDA', status: DocumentStatus.EM_REVISAO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 300, taxAmount: 69, total: 369, currency: 'EUR', metadata: {} },
      { id: 'd4', tenantId: TENANT_ID, docNumber: 'FT 4', atcud: 'A4', docDate: new Date('2026-03-04'), type: 'FATURA_RECEBIDA', status: DocumentStatus.REJEITADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 400, taxAmount: 92, total: 492, currency: 'EUR', metadata: {} },
    ];
    const prisma = buildPrismaStub(documents);
    const audit = { log: jest.fn(async () => undefined) };
    const svc = makeService(prisma, audit);

    const range = { from: new Date('2026-03-01'), to: new Date('2026-03-31') };
    // Drain the generator + complete the audit emission.
    for await (const _chunk of svc.streamSaft(TENANT_ID, 'user-1', range)) {
      void _chunk;
    }

    // The Prisma findMany call MUST scope by status APROVADO so a
    // NOVO / REJEITADO / EM_REVISAO row never reaches the XML.
    expect(prisma.document.findMany).toHaveBeenCalled();
    const callArgs = prisma.document.findMany.mock.calls[0][0];
    expect(callArgs.where.status).toBe(DocumentStatus.APROVADO);
    expect(callArgs.where.deletedAt).toBeNull();
    expect(callArgs.where.tenantId).toBe(TENANT_ID);
  });

  it('narrows the result to documents whose docDate falls in the window', async () => {
    const documents = [
      { id: 'd1', tenantId: TENANT_ID, docNumber: 'FT 1', atcud: 'A1', docDate: new Date('2026-02-15'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 100, taxAmount: 23, total: 123, currency: 'EUR', metadata: {} },
      { id: 'd2', tenantId: TENANT_ID, docNumber: 'FT 2', atcud: 'A2', docDate: new Date('2026-03-15'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 200, taxAmount: 46, total: 246, currency: 'EUR', metadata: {} },
      { id: 'd3', tenantId: TENANT_ID, docNumber: 'FT 3', atcud: 'A3', docDate: new Date('2026-03-20'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 300, taxAmount: 69, total: 369, currency: 'EUR', metadata: {} },
      { id: 'd4', tenantId: TENANT_ID, docNumber: 'FT 4', atcud: 'A4', docDate: new Date('2026-04-01'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 400, taxAmount: 92, total: 492, currency: 'EUR', metadata: {} },
    ];
    const prisma = buildPrismaStub(documents);
    const audit = { log: jest.fn(async () => undefined) };
    const svc = makeService(prisma, audit);

    const range = { from: new Date('2026-03-01'), to: new Date('2026-03-31') };
    for await (const _chunk of svc.streamSaft(TENANT_ID, 'user-1', range)) {
      void _chunk;
    }

    // The service asks Prisma for an inclusive range — verify
    // the bracket lands on the same day (to.setUTCHours end-of-day).
    const callArgs = prisma.document.findMany.mock.calls[0][0];
    expect(callArgs.where.docDate.gte).toEqual(range.from);
    expect(callArgs.where.docDate.lte.getUTCDate()).toBe(31);
    expect(callArgs.where.docDate.lte.getUTCHours()).toBe(23);
  });

  it('emits an AuditAction.EXPORT row with period + counts + chain head/tail', async () => {
    const documents = [
      { id: 'd1', tenantId: TENANT_ID, docNumber: 'FT 1', atcud: 'A1', docDate: new Date('2026-03-01'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 100, taxAmount: 23, total: 123, currency: 'EUR', metadata: {} },
      { id: 'd2', tenantId: TENANT_ID, docNumber: 'FT 2', atcud: 'A2', docDate: new Date('2026-03-02'), type: 'FATURA_RECEBIDA', status: DocumentStatus.APROVADO, supplier: 'S', supplierNif: '123', customer: 'C', customerNif: '999', netAmount: 200, taxAmount: 46, total: 246, currency: 'EUR', metadata: {} },
    ];
    const prisma = buildPrismaStub(documents);
    const audit = { log: jest.fn(async () => undefined) };
    const svc = makeService(prisma, audit);

    const range = { from: new Date('2026-03-01'), to: new Date('2026-03-31') };
    for await (const _chunk of svc.streamSaft(TENANT_ID, 'user-1', range)) {
      void _chunk;
    }

    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = audit.log.mock.calls[0][0];
    expect(auditArg.action).toBe(AuditAction.EXPORT);
    expect(auditArg.entityType).toBe('saft_export');
    expect(auditArg.metadata).toMatchObject({
      subAction: 'saft.export',
      period: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
      documentCount: 2,
      version: '1.04_01',
    });
    expect(typeof auditArg.metadata.hashChainHead).toBe('string');
    expect(typeof auditArg.metadata.hashChainTail).toBe('string');
    expect(/^[0-9a-f]{40}$/.test(auditArg.metadata.hashChainHead)).toBe(true);
    expect(/^[0-9a-f]{40}$/.test(auditArg.metadata.hashChainTail)).toBe(true);
  });
});
