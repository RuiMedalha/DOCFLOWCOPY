import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { StorageService } from '../documents/storage/storage-service.interface';
import { OutlookService } from '../email-inbound/outlook.service';
import { randomUUID } from 'crypto';
import {
  AuditAction,
  DocumentStatus,
  PaymentEventStatus,
  PaymentStatus,
  Prisma,
  RecurrenceType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ApprovePayableDto,
  CreateManualPayableDto,
  CreatePayableFromDocumentDto,
  CreatePaymentScheduleDto,
  ListPayablesQueryDto,
  ListPaymentSchedulesQueryDto,
  MarkPaidPayableDto,
  PayPaymentEventDto,
  SepaExportDto,
  SepaExportResponseDto,
  UpdatePayableDto,
  UpdatePaymentScheduleDto,
} from './dto/payments.dto';
import {
  buildSepaPain001Xml,
  computeSepaTotals,
  SepaCreditTransfer,
  SepaExportInput,
  SepaPaymentInstruction,
} from './iso20022-sepa.builder';

/**
 * PaymentsService — payables + payment schedule + SEPA export.
 *
 * Three concerns share one service because they share one data flow:
 *
 *   PayableItem ←────────┐
 *   PaymentSchedule      │── all block until status=APPROVED
 *   Party                │   ── then export to SEPA pain.001
 *
 * Approve is gated by route-level @Roles(ADMIN,APPROVER) AND by the user's
 * `canApprovePayments` flag (see Wave 1 RBAC contract). Marking paid is
 * not approval-gated — an OPERADOR who imported a CAMT.053 statement
 * needs to flip the status without ceremony.
 *
 * All mutations write to the hash-chained AuditLog via AuditService so
 * the payments trail stays tamper-evident.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(StorageService) private readonly storage?: StorageService,
    @Optional() @Inject(forwardRef(() => OutlookService)) private readonly outlook?: OutlookService,
  ) {}

  async calendarEvents(tenantId: string, from: string, to: string) {
    const start = this.parseCalendarDate(from, 'from');
    const end = this.parseCalendarDate(to, 'to');
    end.setUTCHours(23, 59, 59, 999);
    if (start > end) throw new BadRequestException('from must be before to');
    const now = new Date();
    const events = await this.prisma.paymentEvent.findMany({
      where: { tenantId, dueDate: { gte: start, lte: end } },
      include: { document: { select: { id: true, supplier: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return events.map((event) => {
      const dueDate = new Date(event.dueDate);
      const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86_400_000);
      const status = event.status === PaymentEventStatus.PENDING && daysUntilDue < 0
        ? PaymentEventStatus.OVERDUE : event.status;
      return { id: event.id, documentId: event.documentId,
        supplier: event.document.supplier ?? 'Fornecedor não identificado',
        dueDate: dueDate.toISOString(), amount: Number(event.amount), status, daysUntilDue };
    });
  }

  async payEvent(tenantId: string, userId: string, id: string, dto: PayPaymentEventDto) {
    const existing = await this.prisma.paymentEvent.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('PaymentEvent not found');
    if (existing.status === PaymentEventStatus.PAID) return this.sanitizePaymentEvent(existing);
    const paidAmount = dto.amount ?? Number(existing.amount);
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    const updated = await this.prisma.paymentEvent.update({ where: { id }, data: {
      status: PaymentEventStatus.PAID, paidAmount: new Prisma.Decimal(paidAmount), paidAt,
      paymentMethod: dto.method ?? 'transfer',
    }});
    await this.audit.log({ tenantId, userId, action: AuditAction.PAYMENT_CONFIRM,
      entityType: 'payment_event', entityId: id,
      metadata: { paidAmount, paidAt: paidAt.toISOString(), method: dto.method ?? 'transfer' },
    });
    return this.sanitizePaymentEvent(updated);
  }

  // ════════════════════════════════════════════ PAYABLES ════════════════════

  /**
   * Paginated listing of payables for the tenant. Filters: status, dueDate
   * window, partyId, approved-only, overdue-only.
   */
  async listPayables(tenantId: string, query: ListPayablesQueryDto) {
    // Self-healing sync: bring in any active documents with payment dates that don't have a PayableItem
    await this.syncMissingDocumentPayables(tenantId).catch((err) => {
      this.logger.warn(`Failed auto-syncing document payables for tenant ${tenantId}: ${err.message}`);
    });

    const where: Prisma.PayableItemWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.partyId) where.partyId = query.partyId;
    if (query.approvedOnly) {
      where.approvedAt = { not: null };
    }
    if (query.overdueOnly) {
      const now = new Date();
      where.dueDate = { lt: now };
      where.status = { in: [PaymentStatus.TO_PAY, PaymentStatus.OVERDUE] };
    } else if (query.dueDateFrom || query.dueDateTo) {
      const range: Prisma.DateTimeFilter = {};
      if (query.dueDateFrom) range.gte = new Date(query.dueDateFrom);
      if (query.dueDateTo) {
        const to = new Date(query.dueDateTo);
        to.setHours(23, 59, 59, 999);
        range.lte = to;
      }
      where.dueDate = range;
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.payableItem.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.payableItem.count({ where }),
    ]);

    // Hydrate party / document summaries in one shot each.
    const partyIds = Array.from(
      new Set(items.map((i) => i.partyId).filter(Boolean) as string[]),
    );
    const docIds = Array.from(
      new Set(items.map((i) => i.documentId).filter(Boolean) as string[]),
    );
    const [parties, documents] = await Promise.all([
      partyIds.length
        ? this.prisma.party.findMany({
            where: { tenantId, id: { in: partyIds } },
            select: {
              id: true,
              name: true,
              nif: true,
              iban: true,
              bic: true,
              ibanFlagged: true,
              ibanVerified: true,
            },
          })
        : Promise.resolve([]),
      docIds.length
        ? this.prisma.document.findMany({
            where: { tenantId, id: { in: docIds } },
            select: {
              id: true,
              fileName: true,
              docNumber: true,
              atcud: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const partyById = new Map(parties.map((p) => [p.id, p]));
    const docById = new Map(documents.map((d) => [d.id, d]));

    return {
      items: items.map((p) => this.sanitizePayable(p, partyById, docById)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOnePayable(tenantId: string, id: string) {
    const p = await this.prisma.payableItem.findFirst({
      where: { id, tenantId },
    });
    if (!p) throw new NotFoundException('PayableItem not found');
    return this.sanitizePayable(
      p,
      await this.partyMap([p.partyId].filter(Boolean) as string[], tenantId),
      await this.documentMap([p.documentId].filter(Boolean) as string[], tenantId),
    );
  }

  /**
   * Self-healing sync: scans the tenant's documents for any active items that
   * have a dueDate or paymentDueDate but do NOT yet have a PayableItem linked.
   * Auto-creates them so the "Contas a Pagar" view always reflects reality.
   */
  async syncMissingDocumentPayables(tenantId: string): Promise<number> {
    const unlinkedDocs = await this.prisma.document.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { notIn: [DocumentStatus.REJEITADO, DocumentStatus.ARQUIVADO] },
        OR: [
          { dueDate: { not: null } },
          { paymentDueDate: { not: null } },
          { total: { gt: 0 } },
        ],
        payableItems: { none: {} },
      },
      select: {
        id: true,
        tenantId: true,
        partyId: true,
        supplier: true,
        docNumber: true,
        fileName: true,
        total: true,
        netAmount: true,
        docDate: true,
        dueDate: true,
        paymentDueDate: true,
        status: true,
        paymentStatus: true,
        metadata: true,
        createdAt: true,
      },
      take: 100,
    });

    let count = 0;
    for (const doc of unlinkedDocs) {
      const effectiveDueDate = doc.dueDate ?? doc.paymentDueDate ?? doc.docDate ?? doc.createdAt ?? new Date();
      const effectiveAmount = doc.total ?? doc.netAmount;
      const amountNum = effectiveAmount ? Number(effectiveAmount) : 0;

      let payableStatus: PaymentStatus = PaymentStatus.TO_PAY;
      if (doc.paymentStatus === PaymentStatus.PAID) {
        payableStatus = PaymentStatus.PAID;
      } else if (doc.paymentStatus === PaymentStatus.SCHEDULED) {
        payableStatus = PaymentStatus.SCHEDULED;
      } else if (doc.paymentStatus === PaymentStatus.CANCELLED) {
        payableStatus = PaymentStatus.CANCELLED;
      } else if (effectiveDueDate && new Date(effectiveDueDate) < new Date()) {
        payableStatus = PaymentStatus.OVERDUE;
      }

      const description = `${doc.supplier ?? 'Fornecedor'} — ${doc.docNumber ?? doc.fileName}`;
      const metaPaymentMethod =
        doc.metadata && typeof doc.metadata === 'object' && (doc.metadata as any).paymentMethod
          ? (doc.metadata as any).paymentMethod
          : null;

      await this.prisma.payableItem.create({
        data: {
          tenantId,
          documentId: doc.id,
          partyId: doc.partyId ?? null,
          description,
          amount: new Prisma.Decimal(amountNum > 0 ? amountNum : 0),
          dueDate: effectiveDueDate ?? new Date(),
          status: payableStatus,
          paymentMethod: metaPaymentMethod ?? null,
          approvedAt: doc.status === DocumentStatus.APROVADO ? new Date() : null,
        },
      });
      count++;
    }
    return count;
  }

  /**
   * Generate a PayableItem from an inbound document (fatura_recebida,
   * fatura, etc.). Copies the supplier, total, dueDate, and IBAN when
   * present. If the document is already linked to a payable, we throw a
   * 409 — duplicate protection is cheaper than auto-dedupe on writes.
   */
  async createPayableFromDocument(
    tenantId: string,
    userId: string,
    dto: CreatePayableFromDocumentDto,
  ) {
    const doc = await this.prisma.document.findFirst({
      where: { id: dto.documentId, tenantId },
      include: {
        payableItems: { take: 1 },
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.payableItems.length) {
      throw new BadRequestException(
        'Document already has a PayableItem linked',
      );
    }

    const amount =
      dto.amount ?? (doc.total != null ? Number(doc.total) : null);
    if (amount == null || !Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Document has no total; supply amount explicitly',
      );
    }

    const dueDate = dto.dueDate ? new Date(dto.dueDate) : doc.dueDate;
    if (!dueDate) {
      throw new BadRequestException(
        'Document has no dueDate; supply one explicitly',
      );
    }

    const created = await this.prisma.payableItem.create({
      data: {
        tenantId,
        documentId: doc.id,
        partyId: dto.partyId ?? doc.partyId ?? null,
        description:
          dto.description ??
          `${doc.supplier ?? 'Fornecedor'} — ${doc.docNumber ?? doc.fileName}`,
        amount: new Prisma.Decimal(amount),
        dueDate,
        status: PaymentStatus.TO_PAY,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'payable_item',
      entityId: created.id,
      metadata: {
        documentId: doc.id,
        docNumber: doc.docNumber,
        amount,
      },
    });

    return this.findOnePayable(tenantId, created.id);
  }

  /** Standalone payable (no inbound document). */
  async createManualPayable(
    tenantId: string,
    userId: string,
    dto: CreateManualPayableDto,
  ) {
    if (dto.partyId) await this.assertPartyExists(tenantId, dto.partyId);
    if (dto.documentId) await this.assertDocumentExists(tenantId, dto.documentId);

    const dueDate = dto.dueDate
      ? new Date(dto.dueDate)
      : this.defaultDueDate(dto.amount);

    const created = await this.prisma.payableItem.create({
      data: {
        tenantId,
        documentId: dto.documentId ?? null,
        partyId: dto.partyId ?? null,
        description: dto.description,
        amount: new Prisma.Decimal(dto.amount),
        dueDate,
        status: PaymentStatus.TO_PAY,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'payable_item',
      entityId: created.id,
      metadata: {
        manual: true,
        amount: dto.amount,
        dueDate: dueDate.toISOString(),
      },
    });

    return this.findOnePayable(tenantId, created.id);
  }

  /** Partial update of the editable fields. Approval is a separate route. */
  async updatePayable(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdatePayableDto,
  ) {
    const existing = await this.prisma.payableItem.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        amount: true,
        dueDate: true,
        description: true,
      },
    });
    if (!existing) throw new NotFoundException('PayableItem not found');
    if (existing.status === PaymentStatus.PAID) {
      throw new BadRequestException(
        'Payable already paid — unmark before editing',
      );
    }

    const data: Prisma.PayableItemUpdateInput = {};
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.dueDate !== undefined) data.dueDate = new Date(dto.dueDate);
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.notes !== undefined) data.notes = dto.notes;

    const updated = await this.prisma.payableItem.update({ where: { id }, data });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'payable_item',
      entityId: id,
      metadata: {
        changes: Object.keys(dto).filter((k) => (dto as any)[k] !== undefined),
      },
    });

    return this.findOnePayable(tenantId, updated.id);
  }

  /**
   * Soft-approve a payable. RBAC for ADMIN/APPROVER is enforced at the
   * route layer via `@Roles(Role.ADMIN, Role.APPROVER)`. The service
   * owns the state-machine invariants (already-approved, already-paid,
   * status transitions).
   */
  async approvePayable(
    tenantId: string,
    userId: string,
    id: string,
    dto: ApprovePayableDto,
  ) {
    const existing = await this.prisma.payableItem.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        approvedAt: true,
        amount: true,
        partyId: true,
        documentId: true,
      },
    });
    if (!existing) throw new NotFoundException('PayableItem not found');
    if (existing.approvedAt) {
      throw new BadRequestException('Payable already approved');
    }
    if (
      existing.status === PaymentStatus.PAID ||
      existing.status === PaymentStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot approve a payable in status ${existing.status}`,
      );
    }

    const updated = await this.prisma.payableItem.update({
      where: { id },
      data: {
        approvedAt: new Date(),
        approvedById: userId,
        status: PaymentStatus.SCHEDULED,
      },
    });

    if (existing.documentId) {
      await this.prisma.document.update({
        where: { id: existing.documentId },
        data: { paymentStatus: PaymentStatus.SCHEDULED },
      }).catch((err) => {
        this.logger.warn(`Failed updating document paymentStatus on approve: ${err.message}`);
      });
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.APPROVE,
      entityType: 'payable_item',
      entityId: id,
      metadata: {
        amount: Number(updated.amount),
        partyId: existing.partyId,
        note: dto.note ?? null,
      },
    });

    return this.findOnePayable(tenantId, updated.id);
  }

  /**
   * Mark a payable as paid — sets status=PAID, paidAt=now, paidAmount,
   * paymentMethod and paymentRef. Optionally links to a BankTransaction
   * for downstream reconciliation close-the-loop.
   *
   * C-09 fix: refuse to silently accept a paidAmount that differs from
   * the payable amount by more than 1 cent. Operators must explicitly
   * supply a `partialReason` (e.g. supplier discount, currency rounding,
   * bank fee) to record why the actual paid amount is different. We
   * still store whatever paidAmount the caller gave us — the audit row
   * is the source of truth for "what really happened".
   */
  async markPayablePaid(
    tenantId: string,
    userId: string,
    id: string,
    dto: MarkPaidPayableDto,
  ) {
    const existing = await this.prisma.payableItem.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        amount: true,
        approvedAt: true,
        documentId: true,
      },
    });
    if (!existing) throw new NotFoundException('PayableItem not found');
    if (!existing.approvedAt) {
      throw new BadRequestException(
        'Payable must be approved before being marked paid',
      );
    }
    if (existing.status === PaymentStatus.PAID) {
      throw new BadRequestException('Payable already paid');
    }

    const expectedAmount = Number(existing.amount);
    const paidAmount = dto.paidAmount ?? expectedAmount;
    const diff = Math.abs(paidAmount - expectedAmount);

    // Reject silently-swallowed amount mismatches: the previous code
    // accepted whatever paidAmount came in, which made it trivial to
    // mark a 100€ payable paid with 1€ without any audit signal.
    // Operators MUST pass a partialReason to record a partial payment
    // — the audit row captures both the reason and the expected vs
    // paid diff so reconciliation can spot the mismatch later.
    if (diff > 0.01) {
      if (!dto.partialReason || dto.partialReason.trim().length === 0) {
        throw new BadRequestException(
          `paidAmount=${paidAmount} differs from the payable amount (${expectedAmount}) by ${diff.toFixed(
            2,
          )}. Provide a partialReason to record a partial / corrected payment.`,
        );
      }
    }

    const updated = await this.prisma.payableItem.update({
      where: { id },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        paidAmount: new Prisma.Decimal(paidAmount),
        paymentMethod: dto.paymentMethod ?? 'transfer',
        paymentRef: dto.paymentRef ?? null,
        bankTxId: dto.bankTxId ?? null,
        notes:
          dto.partialReason && dto.partialReason.trim().length > 0
            ? dto.partialReason
            : undefined,
      },
    });

    if (existing.documentId) {
      await this.prisma.document.update({
        where: { id: existing.documentId },
        data: { paymentStatus: PaymentStatus.PAID },
      }).catch((err) => {
        this.logger.warn(`Failed updating document status on mark-paid: ${err.message}`);
      });

      // Fase 4.6 (P1): Ao pagar, mover de FATURAS A PAGAR para COMPRAS/<ANO> no MinIO e no OneDrive
      await this.relocatePaidDocumentToPurchases(tenantId, existing.documentId).catch((err) => {
        this.logger.warn(`[markPaid] Falha ao relocalizar documento pago: ${err.message}`);
      });
    }

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.PAYMENT_CONFIRM,
      entityType: 'payable_item',
      entityId: id,
      metadata: {
        paidAmount,
        expectedAmount,
        diff,
        partialReason: dto.partialReason ?? null,
        paymentMethod: dto.paymentMethod ?? 'transfer',
        paymentRef: dto.paymentRef ?? null,
      },
    });

    return this.findOnePayable(tenantId, updated.id);
  }

  // ════════════════════════════════════════════ SCHEDULE ════════════════════

  /** Paginated listing of payment schedules — used by the calendar view. */
  async listSchedules(tenantId: string, query: ListPaymentSchedulesQueryDto) {
    const where: Prisma.PaymentScheduleWhereInput = { tenantId };
    if (query.status) where.status = query.status;
    if (query.partyId) where.crmContactId = query.partyId;
    if (query.dueDateFrom || query.dueDateTo) {
      const range: Prisma.DateTimeFilter = {};
      if (query.dueDateFrom) range.gte = new Date(query.dueDateFrom);
      if (query.dueDateTo) {
        const to = new Date(query.dueDateTo);
        to.setHours(23, 59, 59, 999);
        range.lte = to;
      }
      where.dueDate = range;
    }

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.paymentSchedule.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.paymentSchedule.count({ where }),
    ]);

    return {
      items: items.map((s) => this.sanitizeSchedule(s)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Calendar view: returns all schedules that fall in `[from, to]` with
   * the recurrence-expanded instances for recurring ones. Keeps the UI
   * simple — we just project the next N occurrences inline rather than
   * materializing them in the DB.
   */
  async calendarView(
    tenantId: string,
    dateFrom: string,
    dateTo: string,
    options: { maxOccurrences?: number; maxItems?: number } = {},
  ) {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    to.setHours(23, 59, 59, 999);
    const maxOcc = options.maxOccurrences ?? 12;
    const maxItems = options.maxItems ?? 500;

    const schedules = await this.prisma.paymentSchedule.findMany({
      where: {
        tenantId,
        OR: [
          { dueDate: { gte: from, lte: to } },
          { recurring: true, dueDate: { lte: to } },
        ],
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
      take: maxItems,
    });

    const expanded: Array<{
      scheduleId: string;
      title: string;
      amount: number;
      dueDate: string;
      status: PaymentStatus;
      category: string | null;
      paymentMethod: string | null;
      recurring: boolean;
      recurrenceType: RecurrenceType | null;
    }> = [];

    for (const s of schedules) {
      if (!s.recurring || !s.recurrenceType) {
        if (s.dueDate >= from && s.dueDate <= to) {
          expanded.push({
            scheduleId: s.id,
            title: s.title,
            amount: Number(s.amount),
            dueDate: this.toLocalDateString(s.dueDate),
            status: s.status,
            category: s.category,
            paymentMethod: s.paymentMethod,
            recurring: false,
            recurrenceType: null,
          });
        }
        continue;
      }
      const interval = s.recurrenceInterval ?? 1;
      let cursor = new Date(s.dueDate);
      let emitted = 0;
      while (cursor <= to && emitted < maxOcc) {
        if (cursor >= from) {
          expanded.push({
            scheduleId: s.id,
            title: s.title,
            amount: Number(s.amount),
            dueDate: this.toLocalDateString(cursor),
            status: this.deriveScheduleStatus(s, cursor),
            category: s.category,
            paymentMethod: s.paymentMethod,
            recurring: true,
            recurrenceType: s.recurrenceType,
          });
          emitted++;
        }
        cursor = this.advanceRecurrence(cursor, s.recurrenceType, interval);
      }
    }

    expanded.sort(
      (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime(),
    );

    return {
      from: this.toLocalDateString(from),
      to: this.toLocalDateString(to),
      count: expanded.length,
      items: expanded,
    };
  }

  async createSchedule(
    tenantId: string,
    userId: string,
    dto: CreatePaymentScheduleDto,
  ) {
    if (dto.partyId) await this.assertPartyExists(tenantId, dto.partyId);
    if (dto.documentId) await this.assertDocumentExists(tenantId, dto.documentId);
    if (dto.recurring && !dto.recurrenceType) {
      throw new BadRequestException(
        'recurring schedules require a recurrenceType',
      );
    }
    if (!dto.recurring && dto.recurrenceType) {
      // Be permissive: accept a recurrence type on a non-recurring row
      // and just turn the flag on. Recurrence is a property of the
      // schedule, not a separate object.
    }

    const created = await this.prisma.paymentSchedule.create({
      data: {
        tenantId,
        title: dto.title,
        description: dto.description,
        amount: new Prisma.Decimal(dto.amount),
        dueDate: new Date(dto.dueDate),
        status: PaymentStatus.SCHEDULED,
        category: dto.category,
        paymentMethod: dto.paymentMethod ?? 'transfer',
        documentId: dto.documentId,
        crmContactId: dto.partyId,
        recurring: dto.recurring ?? false,
        recurrenceType: dto.recurrenceType ?? null,
        recurrenceInterval: dto.recurrenceInterval ?? 1,
        createdById: userId,
      },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.CREATE,
      entityType: 'payment_schedule',
      entityId: created.id,
      metadata: {
        title: created.title,
        amount: Number(created.amount),
        recurring: created.recurring,
        recurrenceType: created.recurrenceType,
      },
    });

    return this.sanitizeSchedule(created);
  }

  async updateSchedule(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdatePaymentScheduleDto,
  ) {
    const existing = await this.prisma.paymentSchedule.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('PaymentSchedule not found');

    const data: Prisma.PaymentScheduleUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.dueDate !== undefined) data.dueDate = new Date(dto.dueDate);
    if (dto.paymentDate !== undefined)
      data.paymentDate = new Date(dto.paymentDate);
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.paymentMethod !== undefined)
      data.paymentMethod = dto.paymentMethod;
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.recurring !== undefined) data.recurring = dto.recurring;
    if (dto.recurrenceType !== undefined)
      data.recurrenceType = dto.recurrenceType;
    if (dto.recurrenceInterval !== undefined)
      data.recurrenceInterval = dto.recurrenceInterval;

    const updated = await this.prisma.paymentSchedule.update({
      where: { id },
      data,
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EDIT,
      entityType: 'payment_schedule',
      entityId: id,
      metadata: {
        changes: Object.keys(dto).filter((k) => (dto as any)[k] !== undefined),
      },
    });

    return this.sanitizeSchedule(updated);
  }

  async softDeleteSchedule(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.paymentSchedule.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('PaymentSchedule not found');

    await this.prisma.paymentSchedule.update({
      where: { id },
      data: { status: PaymentStatus.CANCELLED },
    });

    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.DELETE,
      entityType: 'payment_schedule',
      entityId: id,
      metadata: { reason: 'soft-cancel' },
    });

    return { id, status: PaymentStatus.CANCELLED };
  }

  // ════════════════════════════════════════════ SEPA EXPORT ═════════════════

  /**
   * Build a SEPA pain.001.001.03 export for the tenant's approved
   * (TO_PAY / SCHEDULED) payables. Returns both the parsed summary
   * (totals, included ids) and the rendered XML.
   */
  async exportSepa(
    tenantId: string,
    userId: string,
    dto: SepaExportDto,
  ): Promise<{
    summary: SepaExportResponseDto;
    xml: string;
    instructions: SepaPaymentInstruction[];
  }> {
    const where: Prisma.PayableItemWhereInput = {
      tenantId,
      approvedAt: { not: null },
      status: { in: [PaymentStatus.TO_PAY, PaymentStatus.SCHEDULED] },
      paidAt: null,
    };
    if (dto.payableIds?.length) {
      where.id = { in: dto.payableIds };
    }

    const payables = await this.prisma.payableItem.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });

    if (!payables.length) {
      throw new BadRequestException(
        'No approved, unpaid payables matched the filter',
      );
    }

    // Resolve tenant (initiating party + debtor) and parties (creditors)
    // in a single batch each.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, iban: true, bic: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (!tenant.iban) {
      throw new BadRequestException(
        'Tenant has no IBAN configured — cannot export SEPA',
      );
    }

    const partyIds = Array.from(
      new Set(payables.map((p) => p.partyId).filter(Boolean) as string[]),
    );
    const parties = partyIds.length
      ? await this.prisma.party.findMany({
          where: { tenantId, id: { in: partyIds } },
          select: {
            id: true,
            name: true,
            iban: true,
            bic: true,
            ibanFlagged: true,
            ibanVerified: true,
          },
        })
      : [];
    const partyById = new Map(parties.map((p) => [p.id, p]));

    // C-08: also load the tenant's IBAN blacklist so the SEPA export
    // cannot include a creditor that has been flagged as fraud/blacklisted.
    // We dedupe IBANs first to keep the lookup small.
    const candidateIbans = Array.from(
      new Set(
        parties
          .map((p) => p.iban)
          .filter((iban): iban is string => !!iban),
      ),
    );
    const blacklistHits = candidateIbans.length
      ? await this.prisma.ibanBlacklist.findMany({
          where: { tenantId, iban: { in: candidateIbans } },
          select: { iban: true, reason: true },
        })
      : [];
    const blacklistedIban = new Set(blacklistHits.map((b) => b.iban));

    const transfers: SepaCreditTransfer[] = [];
    const skipped: Array<{ payableId: string; reason: string }> = [];
    for (const p of payables) {
      const party = p.partyId ? partyById.get(p.partyId) : undefined;
      const creditorIban = party?.iban ?? null;
      const creditorName = party?.name ?? null;
      if (!party || !creditorIban || !creditorName) {
        // SEPA requires an IBAN + name. Skip and report — the caller
        // surfaces the skipped list as metadata so they can fix parties
        // and retry.
        skipped.push({
          payableId: p.id,
          reason: 'party missing IBAN or name',
        });
        continue;
      }
      // C-08: hard-block any creditor whose IBAN is flagged on the
      // party row OR hits the tenant's IbanBlacklist. The audit trail
      // must show this is a security-tagged skip, not a data issue.
      if (party.ibanFlagged) {
        skipped.push({
          payableId: p.id,
          reason: 'security: party IBAN flagged',
        });
        continue;
      }
      if (blacklistedIban.has(creditorIban)) {
        skipped.push({
          payableId: p.id,
          reason: 'security: creditor IBAN on blacklist',
        });
        continue;
      }
      transfers.push({
        endToEndId: p.id,
        amount: Number(p.amount),
        creditorName,
        creditorIban,
        creditorBic: party.bic ?? null,
        remittanceInformation: this.composeRemittance(p),
      });
    }

    if (!transfers.length) {
      throw new BadRequestException(
        `No payable had a usable IBAN+name on its party (skipped: ${skipped
          .map((s) => s.payableId)
          .join(', ')})`,
      );
    }

    const requestedExecutionDate = dto.requestedExecutionDate
      ? new Date(dto.requestedExecutionDate)
      : this.defaultExecutionDate();

    const instruction: SepaPaymentInstruction = {
      paymentInformationId: `PMT-${this.buildMessageIdSuffix(tenantId)}`,
      requestedExecutionDate,
      debtorName: tenant.name,
      debtorIban: tenant.iban,
      debtorBic: tenant.bic ?? null,
      transfers,
    };

    const messageId = `MSG-${this.buildMessageIdSuffix(tenantId)}`;

    const input: SepaExportInput = {
      messageId,
      creationDate: new Date(),
      initiatingPartyName: tenant.name,
      instructions: [instruction],
    };

    // Build the XML — throws BadRequest if any IBAN fails validation.
    const xml = buildSepaPain001Xml(input);
    const totals = computeSepaTotals({ instructions: [instruction] });

    const summary: SepaExportResponseDto = {
      messageId,
      numberOfTransactions: totals.numberOfTransactions,
      controlSum: totals.controlSum,
      payableIds: transfers.map((t) => t.endToEndId),
      requestedExecutionDate: requestedExecutionDate.toISOString(),
    };

    // Record the export as EXPORT audit row — the messageId is the
    // reconciliation key for camt.054 close-the-loop.
    await this.audit.log({
      tenantId,
      userId,
      action: AuditAction.EXPORT,
      entityType: 'sepa_export',
      entityId: messageId,
      metadata: {
        numberOfTransactions: summary.numberOfTransactions,
        controlSum: summary.controlSum,
        skipped: skipped.length ? skipped : undefined,
      },
    });

    return { summary, xml, instructions: [instruction] };
  }

  /**
   * Build a CSV string for the same set of payables — useful for banks
   * that prefer homebanking upload over XML. Same input as exportSepa.
   */
  async exportSepaCsv(
    tenantId: string,
    dto: SepaExportDto,
  ): Promise<{ csv: string; rows: number; controlSum: number }> {
    const where: Prisma.PayableItemWhereInput = {
      tenantId,
      approvedAt: { not: null },
      status: { in: [PaymentStatus.TO_PAY, PaymentStatus.SCHEDULED] },
      paidAt: null,
    };
    if (dto.payableIds?.length) where.id = { in: dto.payableIds };
    const payables = await this.prisma.payableItem.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    if (!payables.length) {
      throw new BadRequestException('No approved payables to export');
    }

    const partyIds = Array.from(
      new Set(payables.map((p) => p.partyId).filter(Boolean) as string[]),
    );
    const parties = partyIds.length
      ? await this.prisma.party.findMany({
          where: { tenantId, id: { in: partyIds } },
          select: { id: true, name: true, iban: true, nif: true },
        })
      : [];
    const partyById = new Map(parties.map((p) => [p.id, p]));

    const escape = (val: unknown): string => {
      if (val == null) return '';
      const s = String(val);
      if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const formatAmount = (n: number): string => n.toFixed(2).replace('.', ',');

    const headers = [
      'Data Execução',
      'EndToEndId',
      'Valor (EUR)',
      'Nome Credor',
      'NIF',
      'IBAN',
      'Referência',
      'Descrição',
    ];
    const executionDate = (
      dto.requestedExecutionDate
        ? new Date(dto.requestedExecutionDate)
        : this.defaultExecutionDate()
    )
      .toISOString()
      .slice(0, 10);

    let controlSum = 0;
    const rows = payables.map((p) => {
      const party = p.partyId ? partyById.get(p.partyId) : null;
      const amount = Number(p.amount);
      controlSum += Math.round(amount * 100) / 100;
      return [
        executionDate,
        p.id,
        formatAmount(amount),
        party?.name ?? '',
        party?.nif ?? '',
        party?.iban ?? '',
        p.paymentRef ?? '',
        p.description ?? '',
      ].map(escape).join(';');
    });

    const csv = [headers.map(escape).join(';'), ...rows].join('\r\n');
    return { csv, rows: payables.length, controlSum };
  }

  // ════════════════════════════════════════════ helpers ═════════════════════

  /** Sanitize one PayableItem row for the API response. */
  private sanitizePayable(
    p: any,
    partyById: Map<string, any>,
    docById: Map<string, any>,
  ) {
    return {
      ...p,
      amount: p.amount != null ? Number(p.amount) : null,
      paidAmount: p.paidAmount != null ? Number(p.paidAmount) : null,
      party: p.partyId ? partyById.get(p.partyId) ?? null : null,
      document: p.documentId ? docById.get(p.documentId) ?? null : null,
    };
  }

  private sanitizeSchedule(s: any) {
    return {
      ...s,
      amount: s.amount != null ? Number(s.amount) : null,
    };
  }

  private async partyMap(ids: string[], tenantId: string) {
    if (!ids.length) return new Map<string, any>();
    const rows = await this.prisma.party.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        nif: true,
        iban: true,
        bic: true,
        ibanFlagged: true,
        ibanVerified: true,
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async documentMap(ids: string[], tenantId: string) {
    if (!ids.length) return new Map<string, any>();
    const rows = await this.prisma.document.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, fileName: true, docNumber: true, atcud: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async assertPartyExists(tenantId: string, partyId: string) {
    const p = await this.prisma.party.findFirst({
      where: { id: partyId, tenantId },
      select: { id: true },
    });
    if (!p) throw new NotFoundException(`Party not found: ${partyId}`);
    return p;
  }

  private async assertDocumentExists(tenantId: string, documentId: string) {
    const d = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: { id: true },
    });
    if (!d) throw new NotFoundException(`Document not found: ${documentId}`);
    return d;
  }

  /** Default due date = today + 30 days for manual payables. */
  private defaultDueDate(_amount: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d;
  }

  /** Default execution date = today + 2 business days. */
  private defaultExecutionDate(): Date {
    const d = new Date();
    let added = 0;
    while (added < 2) {
      d.setDate(d.getDate() + 1);
      const day = d.getDay();
      if (day !== 0 && day !== 6) added++;
    }
    return d;
  }

  /**
   * Compose an unstructured remittance line — keep it short (SEPA caps at
   * 140 chars). Prefer document number + ATCUD when available.
   */
  private composeRemittance(p: any): string {
    const doc = (p as any).document;
    const parts: string[] = [];
    if (p.description) parts.push(p.description);
    if (doc?.docNumber) parts.push(`fat: ${doc.docNumber}`);
    if (doc?.atcud) parts.push(`atcud: ${doc.atcud}`);
    return parts.join(' | ').slice(0, 140);
  }

  /**
   * Advance a date by N steps of a given RecurrenceType. Centralised so
   * the calendar expansion and any future cron job agree on the math.
   *
   * We do the arithmetic on the LOCAL calendar components (year/month/day)
   * rather than via millisecond deltas: a 30-day step is not always a
   * month, and naive `setMonth(M+1)` can drift by one day when DST
   * kicks in mid-month on the server's timezone.
   */
  private advanceRecurrence(
    date: Date,
    type: RecurrenceType,
    interval: number,
  ): Date {
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();
    switch (type) {
      case RecurrenceType.DAILY:
        return new Date(y, m, d + interval);
      case RecurrenceType.WEEKLY:
        return new Date(y, m, d + 7 * interval);
      case RecurrenceType.MONTHLY:
        return new Date(y, m + interval, d);
      case RecurrenceType.QUARTERLY:
        return new Date(y, m + 3 * interval, d);
      case RecurrenceType.YEARLY:
        return new Date(y + interval, m, d);
      default:
        // Unknown type — bail by advancing 1 day so we eventually exit
        // the loop instead of spinning forever.
        return new Date(y, m, d + 1);
    }
  }

  /**
   * For a recurring schedule occurrence on `cursor`, decide what status
   * the calendar view should render. Simple rule: any occurrence in the
   * past (date-only) is OVERDUE unless the source row is already PAID;
   * future occurrences stay SCHEDULED.
   */
  private deriveScheduleStatus(
    source: { status: PaymentStatus; paymentDate?: Date | null },
    cursor: Date,
  ): PaymentStatus {
    if (source.status === PaymentStatus.PAID) return PaymentStatus.PAID;
    if (source.status === PaymentStatus.CANCELLED)
      return PaymentStatus.CANCELLED;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cursorDate = new Date(cursor);
    cursorDate.setHours(0, 0, 0, 0);
    if (cursorDate < today) return PaymentStatus.OVERDUE;
    return PaymentStatus.SCHEDULED;
  }

  /** Suffix used in SEPA MsgId and PmtInfId — short + unique + safe. */
  private buildMessageIdSuffix(tenantId: string): string {
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const tenantShort = tenantId.slice(-6);
    const uuid = randomUUID().replace(/-/g, '').slice(0, 12);
    return `${tenantShort}-${yyyy}${mm}${dd}-${uuid}`;
  }

  /**
   * Format a Date as YYYY-MM-DD using the server's local calendar
   * components. Used by the calendar view: `toISOString()` is in UTC and
   * shifts a day forward/back depending on DST, which would surprise
   * users expecting "the 15th" to render as "the 15th".
   */
  private toLocalDateString(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private parseCalendarDate(value: string, field: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`${field} must be YYYY-MM-DD`);
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} is invalid`);
    return date;
  }

  private sanitizePaymentEvent(event: {
    id: string; documentId: string; dueDate: Date; amount: Prisma.Decimal;
    status: PaymentEventStatus; paidAt: Date | null; paidAmount: Prisma.Decimal | null;
    paymentMethod: string | null; notes: string | null;
  }) {
    return {
      ...event,
      amount: Number(event.amount),
      paidAmount: event.paidAmount === null ? null : Number(event.paidAmount),
    };
  }

  /**
   * Fase 4.6 (P1): Move o documento pago de FATURAS A PAGAR para COMPRAS/<ANO>
   * no MinIO / Storage e no espelho do OneDrive.
   */
  private async relocatePaidDocumentToPurchases(tenantId: string, documentId: string): Promise<void> {
    if (!this.storage) return;

    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, tenantId },
      select: {
        id: true,
        fileKey: true,
        pdfKey: true,
        docDate: true,
        supplier: true,
        fileName: true,
      },
    });
    if (!doc || !doc.fileKey) return;

    const targetKey = doc.pdfKey ?? doc.fileKey;
    if (targetKey.includes('FATURAS A PAGAR') || targetKey.includes('FATURAS_A_PAGAR')) {
      const year = doc.docDate ? doc.docDate.getUTCFullYear() : new Date().getUTCFullYear();
      const cleanSupplier = (doc.supplier ?? 'Fornecedor').replace(/[^a-zA-Z0-9._ -]/g, '').trim();
      const filename = doc.fileName;

      const newKey = `FORNECEDORES/COMPRAS/${cleanSupplier}/${year}/${filename}`;
      try {
        await this.storage.move(targetKey, newKey);
        await this.prisma.document.update({
          where: { id: documentId },
          data: {
            fileKey: doc.pdfKey ? doc.fileKey : newKey,
            pdfKey: doc.pdfKey ? newKey : null,
          },
        });

        if (this.outlook) {
          await this.outlook.moveOneDriveFile(targetKey, newKey).catch(() => undefined);
        }
        this.logger.log(`[relocatePaidDocumentToPurchases] Documento ${documentId} movido para compras: ${newKey}`);
      } catch (err) {
        this.logger.warn(`[relocatePaidDocumentToPurchases] Falha ao mover ${targetKey} -> ${newKey}: ${(err as Error).message}`);
      }
    }
  }
}
