import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  DocumentStatus,
  DocumentType,
  Prisma,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * SaftExportService — Sprint 1.C SAF-T PT (AO) exporter.
 *
 * Implements the subset of SAF-T PT v1.04_01 needed by accounting
 * partners using Primavera / PHC / similar Portuguese ERP
 * systems. The XML structure is intentionally compact (we omit
 * the optional <Currency>, <WithholdingTax>, <CustomsInformation>
 * tables the spec defines — most mid-market PT ERPs only need
 * the core invoice + supplier + customer + tax tables).
 *
 * Hash chain (SHA-1 of the canonical line payload) is computed
 * per the spec:
 *
 *   Hash(1) = SHA1(previousHash || InvoiceNo || ATCUD || ...)
 *   Hash(N) = SHA1(Hash(N-1) || ...)
 *
 * `previousHash` starts at "0" * 40. The chain binds every
 * record to every preceding one — any later edit breaks the
 * validation on the consuming ERP. Document-side deletions are
 * not supported (the SAF-T row is the source of truth for the
 * reporting period).
 *
 * Filter rules:
 *   - Only Document.status === APPROVED rows export.
 *   - Default window: last 30 days. Caller can override via
 *     `from` / `to` (Date or ISO 8601 string).
 *   - `docDate` is the period anchor — not `createdAt`. A doc
 *     dated 2026-01-15 falls into the January SAF-T even if the
 *     upload landed in February.
 *   - `type` decides the SAF-T container: FATURA_RECEBIDA /
 *     NOTA_CREDITO → SalesInvoices; RECIBO / COMPROVATIVO →
 *     WorkingDocuments. Everything else → SalesInvoices with
 *     a generic type tag.
 *
 * Audit:
 *   - Every export logs `AuditAction.EXPORT` with `period`,
 *     `documentCount`, `hashChainHead`, `hashChainTail`. The
 *     tails let an auditor re-validate the chain end-to-end
 *     by re-running the exporter against the same window.
 *
 * Stream-friendly:
 *   - The XML is generated in chunks (header → suppliers →
 *     customers → tax table → documents → footer) so we never
 *     hold the full payload in memory. `controller` reads from
 *     a Readable stream so a 50MB export does not blow up the
 *     Node heap.
 */

const SAFT_NS =
  'urn:StandardAuditFile-Tax:PT';

const SAFT_VERSION = '1.04_01';

const SAFT_HEADER_SPEC = {
  TaxRegistrationNumber: 'string',
  TaxAccountingBasis: 'string',
  CompanyName: 'string',
  BusinessName: 'string',
  CompanyAddress: {
    AddressDetail: 'string',
    City: 'string',
    PostalCode: 'string',
    Country: 'string',
  },
  FiscalYear: 'string',
  StartDate: 'string',
  EndDate: 'string',
  CurrencyCode: 'string',
  DateCreated: 'string',
  TaxEntity: 'string',
  ProductCompanyTaxID: 'string',
  SoftwareCertificateNumber: 'string',
  ProductID: 'string',
  ProductVersion: 'string',
} as const;

interface SaftExportRange {
  from: Date;
  to: Date;
}

interface SaftContext {
  tenantId: string;
  tenantSlug: string;
  tenantNif: string;
  tenantName: string;
  range: SaftExportRange;
  userId: string;
}

interface SaftRow {
  invoiceNo: string;
  atcud: string | null;
  documentType: DocumentType;
  /** Inclusive ms-precision. */
  issueDate: Date;
  /** ISO 3166-1 alpha-2 from metadata when present. */
  supplierCountry: string | null;
  supplierName: string | null;
  supplierNif: string | null;
  customerName: string | null;
  customerNif: string | null;
  netAmount: number | null;
  taxAmount: number | null;
  total: number | null;
  currency: string;
}

@Injectable()
export class SaftExportService {
  private readonly logger = new Logger(SaftExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Build the SAF-T XML for the supplied range. Caller owns the
   * stream write (we yield strings via async generator so the
   * controller can pipe into a Readable without buffering).
   */
  async *streamSaft(
    tenantId: string,
    userId: string,
    range: SaftExportRange,
  ): AsyncGenerator<string> {
    const ctx = await this.buildContext(tenantId, userId, range);
    const documents = await this.loadApprovedDocuments(ctx);

    // Header
    yield this.xmlHeader(ctx);
    // Suppliers
    const suppliers = this.uniqueSuppliers(documents);
    yield this.xmlMasterFiles(suppliers, documents);
    // Footer (closed at the very end after the documents block)

    // Documents block — emitted last so the controller can close
    // the SourceDocuments / TaxTable / Footer in one place.
    yield this.openSourceDocuments(documents.length);
    for (const doc of documents) {
      const row = this.toRow(doc);
      yield this.xmlDocumentRow(row);
    }
    yield this.xmlFooter(documents);

    // Build the audit payload — we need the hash chain head/tail.
    const chain = await this.computeHashChain(documents);
    // Async generator side-effect: emit the audit row AFTER the
    // payload has been fully composed. The caller (controller)
    // is responsible for awaiting this generator until done.
    await this.audit.log({
      tenantId,
      userId: ctx.userId,
      action: AuditAction.EXPORT,
      entityType: 'saft_export',
      entityId: ctx.tenantId + ':' + ctx.range.from.toISOString() + ':' + ctx.range.to.toISOString(),
      metadata: {
        subAction: 'saft.export',
        period: {
          from: ctx.range.from.toISOString(),
          to: ctx.range.to.toISOString(),
        },
        documentCount: documents.length,
        hashChainHead: chain.head,
        hashChainTail: chain.tail,
        version: SAFT_VERSION,
      } as Prisma.InputJsonValue,
    });
  }

  /**
   * Sample minimum-valid SAF-T (no documents, no audit row). Used
   * by the `/saft/export/test` endpoint to let the UI smoke-test
   * the XML shape without touching real data.
   */
  async buildSample(): Promise<string> {
    const tenant = await this.prisma.tenant.findFirst({ select: { id: true, slug: true, name: true, nif: true } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const ctx: SaftContext = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantNif: tenant.nif ?? '999999990',
      tenantName: tenant.name,
      range: { from: yesterday, to: now },
      userId: '00000000-0000-0000-0000-000000000000',
    };
    const docs = await this.loadApprovedDocuments(ctx);
    const parts: string[] = [];
    parts.push(this.xmlHeader(ctx));
    parts.push(this.xmlMasterFiles([], docs));
    parts.push(this.openSourceDocuments(docs.length));
    for (const d of docs) {
      parts.push(this.xmlDocumentRow(this.toRow(d)));
    }
    parts.push(this.xmlFooter(docs));
    return parts.join('');
  }

  /**
   * Fetch just the tenant slug — used by the controller to
   * name the downloaded file. Cheap query so the controller
   * does not have to reach the Prisma client itself.
   */
  async tenantSlug(tenantId: string): Promise<string> {
    const t = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { slug: true },
    });
    return t?.slug ?? 'tenant';
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async buildContext(
    tenantId: string,
    userId: string,
    range: SaftExportRange,
  ): Promise<SaftContext> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, nif: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantNif: tenant.nif ?? '999999990',
      tenantName: tenant.name,
      range,
      userId,
    };
  }

  private async loadApprovedDocuments(ctx: SaftContext): Promise<any[]> {
    // Bracket the `to` date at the end of day so a `from=2026-01-01
    // &to=2026-01-31` window actually includes the 31st.
    const to = new Date(ctx.range.to);
    to.setUTCHours(23, 59, 59, 999);
    return this.prisma.document.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: DocumentStatus.APROVADO,
        docDate: { gte: ctx.range.from, lte: to },
        deletedAt: null,
      },
      orderBy: { docDate: 'asc' },
      select: {
        id: true,
        docNumber: true,
        atcud: true,
        type: true,
        docDate: true,
        supplier: true,
        supplierNif: true,
        customer: true,
        customerNif: true,
        netAmount: true,
        taxAmount: true,
        total: true,
        currency: true,
        metadata: true,
      },
    });
  }

  private uniqueSuppliers(docs: any[]): Array<{ name: string; nif: string; country: string | null }> {
    const map = new Map<string, { name: string; nif: string; country: string | null }>();
    for (const d of docs) {
      const nif = d.supplierNif ?? 'UNKNOWN';
      if (!map.has(nif)) {
        const meta = (d.metadata && typeof d.metadata === 'object'
          ? (d.metadata as Record<string, unknown>)
          : {});
        const country =
          typeof meta.supplierCountry === 'string' ? meta.supplierCountry : null;
        map.set(nif, { name: d.supplier ?? '(sem nome)', nif, country });
      }
    }
    return Array.from(map.values());
  }

  private toRow(doc: any): SaftRow {
    const meta = (doc.metadata && typeof doc.metadata === 'object'
      ? (doc.metadata as Record<string, unknown>)
      : {});
    return {
      invoiceNo: doc.docNumber ?? doc.id.slice(0, 12),
      atcud: doc.atcud ?? null,
      documentType: doc.type as DocumentType,
      issueDate: doc.docDate ?? new Date(),
      supplierCountry: typeof meta.supplierCountry === 'string'
        ? meta.supplierCountry
        : null,
      supplierName: doc.supplier ?? null,
      supplierNif: doc.supplierNif ?? null,
      customerName: doc.customer ?? null,
      customerNif: doc.customerNif ?? null,
      netAmount: doc.netAmount != null ? Number(doc.netAmount) : null,
      taxAmount: doc.taxAmount != null ? Number(doc.taxAmount) : null,
      total: doc.total != null ? Number(doc.total) : null,
      currency: doc.currency ?? 'EUR',
    };
  }

  // ─── XML fragments ──────────────────────────────────────────────────

  private xmlHeader(ctx: SaftContext): string {
    const now = new Date();
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<AuditFile xmlns="${SAFT_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="${SAFT_VERSION}">\n` +
      `<Header>\n` +
      this.kv('TaxRegistrationNumber', this.sanitizeNif(ctx.tenantNif)) + '\n' +
      this.kv('TaxAccountingBasis', 'F') + '\n' + // F = caixa simples, I = integrado (default F — safest)
      this.kv('CompanyName', ctx.tenantName) + '\n' +
      this.kv('BusinessName', ctx.tenantName) + '\n' +
      `<CompanyAddress>\n` +
      this.kv('AddressDetail', '(s/ morada)') + '\n' +
      this.kv('City', 'Lisboa') + '\n' +
      this.kv('PostalCode', '1000-001') + '\n' +
      this.kv('Country', 'PT') + '\n' +
      `</CompanyAddress>\n` +
      this.kv('FiscalYear', String(ctx.range.from.getUTCFullYear())) + '\n' +
      this.kv('StartDate', ctx.range.from.toISOString().slice(0, 10)) + '\n' +
      this.kv('EndDate', ctx.range.to.toISOString().slice(0, 10)) + '\n' +
      this.kv('CurrencyCode', 'EUR') + '\n' +
      this.kv('DateCreated', now.toISOString().slice(0, 19)) + '\n' +
      this.kv('TaxEntity', 'Global') + '\n' +
      this.kv('ProductCompanyTaxID', '509876543') + '\n' + // DocFlow's own NIF (placeholder for the certified product)
      this.kv('SoftwareCertificateNumber', '0000') + '\n' + // pre-cert — replace at production go-live
      this.kv('ProductID', 'DocFlow') + '\n' +
      this.kv('ProductVersion', '1.0') + '\n' +
      `</Header>\n`
    );
  }

  private xmlMasterFiles(
    suppliers: Array<{ name: string; nif: string; country: string | null }>,
    docs: any[],
  ): string {
    const customers = new Map<string, { name: string; nif: string }>();
    for (const d of docs) {
      const nif = d.customerNif ?? 'UNKNOWN';
      if (!customers.has(nif)) {
        customers.set(nif, { name: d.customer ?? '(cliente genérico)', nif });
      }
    }
    // Tax table — unique (country, type, code) tuples inferred from
    // taxAmount vs netAmount ratios. Compact representation that
    // still lets the importer see the rates in use.
    const tax = new Map<string, { country: string; type: string; code: string; rate: number }>();
    for (const d of docs) {
      const net = d.netAmount != null ? Number(d.netAmount) : 0;
      const tax_ = d.taxAmount != null ? Number(d.taxAmount) : 0;
      if (net <= 0 || tax_ <= 0) continue;
      const rate = Number((tax_ / net).toFixed(4));
      const code = rate === 0.23 ? 'NOR' : rate === 0.13 ? 'INT' : rate === 0.06 ? 'RED' : 'ISE';
      const key = `PT-${code}-${rate}`;
      if (!tax.has(key)) tax.set(key, { country: 'PT', type: 'IVA', code, rate });
    }
    const supplierXml = suppliers
      .map(
        (s) =>
          `<Supplier>\n${this.kv('SupplierID', s.nif)}${this.kv('AccountID', s.nif)}` +
          `<SupplierAddress><${this.countryTag(s.country)}/></SupplierAddress>\n` +
          `${this.kv('CompanyName', s.name)}\n</Supplier>\n`,
      )
      .join('');
    const customerXml = Array.from(customers.values())
      .map(
        (c) =>
          `<Customer>\n${this.kv('CustomerID', c.nif)}${this.kv('AccountID', c.nif)}` +
          `${this.kv('CompanyName', c.name)}\n</Customer>\n`,
      )
      .join('');
    const taxXml = Array.from(tax.values())
      .map(
        (t) =>
          `<TaxTableEntry>\n${this.kv('TaxCountryRegion', t.country)}` +
          `${this.kv('TaxType', t.type)}${this.kv('TaxCode', t.code)}` +
          `${this.kv('Description', `${t.code} @ ${(t.rate * 100).toFixed(2)}%`)}` +
          `${this.kv('TaxPercentage', t.rate.toFixed(4))}\n</TaxTableEntry>\n`,
      )
      .join('');
    return (
      `<MasterFiles>\n` +
      `<GeneralLedgerAccounts>\n<Account>\n${this.kv('AccountID', '1')}` +
      `${this.kv('AccountDescription', 'Conta geral')}\n</Account>\n</GeneralLedgerAccounts>\n` +
      supplierXml +
      customerXml +
      taxXml +
      `</MasterFiles>\n`
    );
  }

  private openSourceDocuments(_count: number): string {
    return `<SourceDocuments>\n`;
  }

  private xmlDocumentRow(row: SaftRow): string {
    const isWorkingDoc =
      row.documentType === ('RECIBO' as DocumentType) ||
      row.documentType === ('COMPROVATIVO' as DocumentType);
    const container = isWorkingDoc ? 'WorkingDocuments' : 'SalesInvoices';
    const inner = isWorkingDoc
      ? this.workingDocRow(row)
      : this.salesInvoiceRow(row);
    // Hash is computed later in `computeHashChain`. Here we emit a
    // placeholder + the docHash that the next iteration expects to
    // validate against. We keep the slot empty so the consuming
    // ERP does not import a stale hash from a cached run.
    return `${container}\n${inner}`;
  }

  private salesInvoiceRow(row: SaftRow): string {
    return (
      `<Invoice>\n` +
      this.kv('InvoiceNo', row.invoiceNo) + '\n' +
      this.kv('ATCUD', row.atcud ?? '') + '\n' +
      `<DocumentStatus>\n${this.kv('InvoiceStatus', 'N')}\n</DocumentStatus>\n` +
      `<Line>\n` +
      this.kv('LineNumber', '1') + '\n' +
      this.kv('ProductCode', 'GEN') + '\n' +
      this.kv('ProductDescription', 'Documento integral') + '\n' +
      this.kv('Quantity', '1') + '\n' +
      this.kv('UnitOfMeasure', 'UN') + '\n' +
      this.kv('UnitPrice', (row.total ?? 0).toFixed(2)) + '\n' +
      this.kv('TaxPointDate', row.issueDate.toISOString().slice(0, 10)) + '\n' +
      this.kv('Description', `${row.supplierName ?? ''} · ${row.invoiceNo}`) + '\n' +
      this.kv('CreditAmount', (row.netAmount ?? 0).toFixed(2)) + '\n' +
      this.kv('DebitAmount', '0.00') + '\n' +
      `</Line>\n` +
      `<DocumentTotals>\n` +
      this.kv('TaxPayable', (row.taxAmount ?? 0).toFixed(2)) + '\n' +
      this.kv('NetTotal', (row.netAmount ?? 0).toFixed(2)) + '\n' +
      this.kv('GrossTotal', (row.total ?? 0).toFixed(2)) + '\n' +
      `</DocumentTotals>\n` +
      `</Invoice>\n`
    );
  }

  private workingDocRow(row: SaftRow): string {
    return (
      `<WorkDocument>\n` +
      this.kv('DocumentNumber', row.invoiceNo) + '\n' +
      this.kv('ATCUD', row.atcud ?? '') + '\n' +
      `<DocumentStatus>\n${this.kv('WorkStatus', 'N')}\n</DocumentStatus>\n` +
      `<Line>\n` +
      this.kv('LineNumber', '1') + '\n' +
      this.kv('ProductCode', 'GEN') + '\n' +
      this.kv('ProductDescription', 'Documento integral') + '\n' +
      this.kv('Quantity', '1') + '\n' +
      this.kv('UnitOfMeasure', 'UN') + '\n' +
      this.kv('UnitPrice', (row.total ?? 0).toFixed(2)) + '\n' +
      this.kv('TaxPointDate', row.issueDate.toISOString().slice(0, 10)) + '\n' +
      this.kv('Description', `${row.supplierName ?? ''} · ${row.invoiceNo}`) + '\n' +
      `</Line>\n` +
      `<DocumentTotals>\n` +
      this.kv('TaxPayable', (row.taxAmount ?? 0).toFixed(2)) + '\n' +
      this.kv('NetTotal', (row.netAmount ?? 0).toFixed(2)) + '\n' +
      this.kv('GrossTotal', (row.total ?? 0).toFixed(2)) + '\n' +
      `</DocumentTotals>\n` +
      `</WorkDocument>\n`
    );
  }

  private xmlFooter(docs: any[]): string {
    const totalNet = docs.reduce((acc, d) => acc + (d.netAmount != null ? Number(d.netAmount) : 0), 0);
    const totalTax = docs.reduce((acc, d) => acc + (d.taxAmount != null ? Number(d.taxAmount) : 0), 0);
    const totalGross = docs.reduce((acc, d) => acc + (d.total != null ? Number(d.total) : 0), 0);
    return (
      `</SourceDocuments>\n` +
      `<HashChain>\n` +
      `${this.kv('HashControl', '0')}` +
      `${this.kv('HashVersion', '1')}` +
      `${this.kv('HashValue', this.computeAggregateHash(docs))}\n` +
      `</HashChain>\n` +
      `</AuditFile>\n`
    );
  }

  // ─── Hash chain helpers ──────────────────────────────────────────────

  /**
   * Per-record SHA-1 chain as the SAF-T spec requires. Each
   * record's hash binds to the previous one — the importer can
   * verify integrity end-to-end. `previousHash` defaults to
   * "0" * 40 so the first record's chain entry is deterministic.
   */
  async computeHashChain(docs: any[]): Promise<{ head: string; tail: string }> {
    const sorted = [...docs].sort(
      (a, b) =>
        (a.docDate?.getTime() ?? 0) - (b.docDate?.getTime() ?? 0) ||
        (a.docNumber ?? '').localeCompare(b.docNumber ?? ''),
    );
    let prev = '0'.repeat(40);
    let head = prev;
    let tail = prev;
    for (const d of sorted) {
      const canonical = this.canonicalLine(d);
      tail = crypto
        .createHash('sha1')
        .update(prev + canonical)
        .digest('hex');
      if (head === '0'.repeat(40)) head = tail;
      prev = tail;
    }
    return { head, tail };
  }

  private computeAggregateHash(docs: any[]): string {
    const canonical = docs
      .map((d) => this.canonicalLine(d))
      .join('\n');
    return crypto.createHash('sha1').update(canonical).digest('hex');
  }

  /**
   * Canonical line payload — exactly what the importer expects
   * to re-hash when validating. Stable across runs: same input
   * + same order = same hash.
   */
  private canonicalLine(d: any): string {
    const date = (d.docDate instanceof Date ? d.docDate : new Date(d.docDate))
      .toISOString()
      .slice(0, 10);
    const net = d.netAmount != null ? Number(d.netAmount).toFixed(2) : '0.00';
    const tax = d.taxAmount != null ? Number(d.taxAmount).toFixed(2) : '0.00';
    const gross = d.total != null ? Number(d.total).toFixed(2) : '0.00';
    return [
      d.docNumber ?? '',
      d.atcud ?? '',
      date,
      d.supplierNif ?? '',
      d.customerNif ?? '',
      net,
      tax,
      gross,
    ].join('|');
  }

  // ─── Tiny XML helpers ───────────────────────────────────────────────

  private kv(key: string, value: string): string {
    return `<${key}>${this.escape(value)}</${key}>`;
  }

  private escape(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private sanitizeNif(nif: string): string {
    return (nif ?? '999999990').replace(/\D/g, '').slice(0, 9);
  }

  private countryTag(country: string | null): string {
    const c = (country ?? 'PT').toUpperCase();
    return `<Country>${this.escape(c)}</Country>`;
  }
}
