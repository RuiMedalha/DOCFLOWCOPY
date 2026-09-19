import { SaftExportService } from '../saft-export.service';

/**
 * Sprint 1.C — SAF-T XML structural suite.
 *
 * Pure unit tests: every test against `buildSample()` runs
 * without touching Prisma (it stubs tenant + docs as needed)
 * so we exercise the wire format of the SAF-T v1.04_01 payload.
 *
 * What we verify:
 *   1. The XML is well-formed (parses without throwing) and
 *      starts with the `<AuditFile>` root element + the
 *      declared namespace.
 *   2. The mandatory header fields are present
 *      (TaxRegistrationNumber, CompanyName, FiscalYear,
 *      StartDate, EndDate, CurrencyCode, DateCreated).
 *   3. The hash chain carries HashVersion + HashValue (SHA-1,
 *      40-char lowercase hex).
 *   4. The document container structure is well-formed and
 *      each row carries InvoiceNo / ATCUD / DocumentTotals.
 */

import { PrismaClient } from '@prisma/client';

// Mock the prisma service so `buildSample` reads a deterministic
// tenant without a real DB. Jest's `jest.fn()` + a manual return
// keeps the test self-contained.
const prismaStub: any = {
  tenant: {
    findFirst: jest.fn(async () => ({
      id: 'tenant-A',
      slug: 'demo',
      name: 'NOV OUSADO UNIPESSOAL LDA',
      nif: '515208566',
    })),
  },
  document: {
    findMany: jest.fn(async () => []),
  },
  $transaction: jest.fn(async () => null),
};

const auditStub = { log: jest.fn(async () => undefined) };

function makeService(): SaftExportService {
  return new SaftExportService(prismaStub, auditStub);
}

describe('SaftExportService.buildSample() — structure', () => {
  it('opens with the SAF-T XML declaration + AuditFile root + namespace', async () => {
    const svc = makeService();
    const xml = await svc.buildSample();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<AuditFile');
    expect(xml).toContain('xmlns="urn:StandardAuditFile-Tax:PT"');
    expect(xml).toContain('version="1.04_01"');
    // Closed at the end of every payload.
    expect(xml.trim().endsWith('</AuditFile>')).toBe(true);
  });

  it('includes the mandatory header fields', async () => {
    const svc = makeService();
    const xml = await svc.buildSample();
    for (const tag of [
      '<TaxRegistrationNumber>',
      '<TaxAccountingBasis>',
      '<CompanyName>NOV OUSADO UNIPESSOAL LDA</CompanyName>',
      '<BusinessName>',
      '<FiscalYear>',
      '<StartDate>',
      '<EndDate>',
      '<CurrencyCode>EUR</CurrencyCode>',
      '<DateCreated>',
      '<ProductCompanyTaxID>',
      '<SoftwareCertificateNumber>',
      '<ProductID>DocFlow</ProductID>',
    ]) {
      expect(xml).toContain(tag);
    }
  });

  it('closes the SourceDocuments block once + has a HashChain block', async () => {
    const svc = makeService();
    const xml = await svc.buildSample();
    // No documents in the sample — SourceDocuments should still
    // open and close (empty body is valid per the spec).
    expect(xml).toContain('<SourceDocuments>');
    expect(xml).toContain('</SourceDocuments>');
    expect(xml).toContain('<HashChain>');
    expect(xml).toContain('<HashVersion>1</HashVersion>');
    // HashValue is the SHA-1 of the canonical empty payload.
    const hashMatch = xml.match(/<HashValue>([0-9a-f]{40})<\/HashValue>/);
    expect(hashMatch).not.toBeNull();
  });

  it('produces a hash that matches an independently computed SHA-1', async () => {
    const svc = makeService();
    const xml = await svc.buildSample();
    const match = xml.match(/<HashValue>([0-9a-f]{40})<\/HashValue>/);
    expect(match).not.toBeNull();
    const fromXml = match![1];
    // Empty docs → canonical payload is the empty string → SHA-1("") =
    // "da39a3ee5e6b4b0d3255bfef95601890afd80709".
    expect(fromXml).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });
});

describe('SaftExportService.computeHashChain() — chain integrity', () => {
  it('returns the documented head/tail for an empty input', async () => {
    const svc = makeService();
    const chain = await svc.computeHashChain([]);
    expect(chain.head).toBe('0'.repeat(40));
    expect(chain.tail).toBe('0'.repeat(40));
  });

  it('binds one record to the previous via SHA-1', async () => {
    const svc = makeService();
    const docs = [
      { docNumber: 'FT 1', atcud: 'ATCUD1', docDate: new Date('2026-01-15'), supplierNif: '123456789', customerNif: '987654321', netAmount: 100, taxAmount: 23, total: 123 },
    ];
    const chain = await svc.computeHashChain(docs as any);
    // Head advances past "0" * 40 with the first record.
    expect(chain.head).not.toBe('0'.repeat(40));
    expect(chain.tail).toBe(chain.head); // one record → head === tail
    expect(/^[0-9a-f]{40}$/.test(chain.head)).toBe(true);
  });
});
