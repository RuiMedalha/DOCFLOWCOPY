/**
 * reset-tenant-documents — devolve um tenant ao estado "antes do primeiro
 * upload", sem destruir a configuração que custou a montar.
 *
 * Serve para recomeçar um teste do zero: apaga os documentos e tudo o que
 * deriva deles (linhas, confirmações de campo, aprovações, eventos de
 * pagamento, propostas/lançamentos contabilísticos, contadores de
 * aprendizagem, histórico de IBAN) e os objetos correspondentes no
 * storage. Não toca em utilizadores, categorias de despesa, categorias de
 * fornecedor, plano de contas, regras de pasta, templates nem no tenant.
 *
 * Entidades (`parties`): só são apagadas as que foram criadas pelo
 * pipeline de extração. O critério não é uma heurística sobre o nome — é
 * a auditoria: `PartiesService.create()` (criação manual e importação CSV)
 * escreve sempre uma linha `AuditLog{action:CREATE, entityType:'party'}`;
 * o `SupplierResolver` do pipeline não escreve nenhuma. Uma entidade sem
 * essa linha nasceu de uma extração. As criadas à mão sobrevivem.
 *
 * Por omissão faz DRY RUN: mostra o que apagaria e não escreve nada.
 * Só com `--apply` é que apaga, e é irreversível.
 *
 *   node dist/src/scripts/reset-tenant-documents.js --tenant=demo
 *   node dist/src/scripts/reset-tenant-documents.js --tenant=demo --apply
 *
 * Flags:
 *   --tenant=<slug>   obrigatório (o slug, não o id — evita enganos)
 *   --apply           executa. Sem isto é dry run.
 *   --folders         apaga também as pastas com nome de um fornecedor
 *                     apagado (criadas pelo folder-routing na aprovação);
 *                     a estrutura Inbox/Despesas/Fornecedores fica
 *   --folders-all     apaga TODAS as pastas, estrutura incluída
 *   --all-parties     apaga todas as entidades, mesmo as criadas à mão
 *   --keep-parties    não apaga nenhuma entidade
 *
 * Env (os mesmos do driver S3Storage): DATABASE_URL, S3_ENDPOINT,
 * S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION.
 */
import { PrismaClient, AuditAction, Prisma } from '@prisma/client';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AuditService } from '../modules/audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';

export interface ResetPlan {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  documentIds: string[];
  storageKeys: string[];
  /** Entidades a apagar (criadas pela extração). */
  partiesToDelete: { id: string; name: string; nif: string | null; docs: number }[];
  /** Entidades preservadas por terem sido criadas à mão / por importação. */
  partiesKept: { id: string; name: string; nif: string | null }[];
  /** Linhas por tabela que a operação remove. */
  counts: Record<string, number>;
  /** Pastas criadas pelo folder-routing a partir de fornecedores apagados. */
  supplierFolders: { id: string; name: string }[];
  /** Pastas estruturais (Inbox/Despesas/Fornecedores e descendentes). */
  structuralFolders: { id: string; name: string }[];
}

/**
 * Nomes de pastas que são estrutura da árvore de arquivo, não resultado de
 * um documento concreto. Sobrevivem sempre a `--folders`.
 */
const STRUCTURAL_ROOTS = ['Inbox', 'Fornecedores', 'Despesas'];

/**
 * Lê o estado atual e devolve o plano. Não escreve nada — é isto que o
 * dry run imprime e é exatamente isto que o `execute` apaga.
 */
export async function buildResetPlan(
  prisma: PrismaClient,
  tenantSlug: string,
  opts: { keepParties?: boolean; allParties?: boolean } = {},
): Promise<ResetPlan> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!tenant) throw new Error(`Tenant '${tenantSlug}' não existe`);
  const tenantId = tenant.id;

  const documents = await prisma.document.findMany({
    where: { tenantId },
    select: { id: true, fileKey: true, pdfKey: true, folderId: true },
  });
  const documentIds = documents.map((d) => d.id);

  // Um objeto só é apagado uma vez: há documentos cujo pdfKey coincide
  // com o fileKey (upload já em PDF que passou pelo derivador).
  const storageKeys = [
    ...new Set(
      documents.flatMap((d) => [d.fileKey, d.pdfKey].filter((k): k is string => !!k)),
    ),
  ];

  // ── entidades ────────────────────────────────────────────────────────
  // A marca de criação manual é a linha de auditoria. Lemos os entityId
  // de uma vez só em vez de N queries.
  const manualCreateRows = await prisma.auditLog.findMany({
    where: { tenantId, entityType: 'party', action: AuditAction.CREATE },
    select: { entityId: true },
  });
  const manuallyCreated = new Set(
    manualCreateRows.map((r) => r.entityId).filter((id): id is string => !!id),
  );

  const allParties = await prisma.party.findMany({
    where: { tenantId },
    select: { id: true, name: true, nif: true, _count: { select: { documents: true } } },
    orderBy: { name: 'asc' },
  });

  // `allParties` ignora a marca de auditoria e leva tudo — usado quando o
  // que foi criado à mão também é dado de teste.
  const partiesToDelete = opts.keepParties
    ? []
    : allParties
        .filter((p) => opts.allParties || !manuallyCreated.has(p.id))
        .map((p) => ({ id: p.id, name: p.name, nif: p.nif, docs: p._count.documents }));
  const deleteIds = new Set(partiesToDelete.map((p) => p.id));
  const partiesKept = allParties
    .filter((p) => !deleteIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, nif: p.nif }));

  // ── contagens do que vai ser removido ────────────────────────────────
  const docFilter = { documentId: { in: documentIds } };
  const [
    items,
    fieldConfirmations,
    approvals,
    paymentEvents,
    paymentSchedules,
    payableItems,
    journalLines,
    expenses,
    invoices,
    matchSuggestions,
    categoryStats,
    ibanHistory,
  ] = await Promise.all([
    prisma.documentItem.count({ where: docFilter }),
    prisma.documentFieldConfirmation.count({ where: docFilter }),
    prisma.approval.count({ where: docFilter }),
    prisma.paymentEvent.count({ where: { tenantId, ...docFilter } }),
    prisma.paymentSchedule.count({ where: { tenantId, ...docFilter } }),
    prisma.payableItem.count({
      where: {
        tenantId,
        OR: [{ documentId: { in: documentIds } }, { partyId: { in: [...deleteIds] } }],
      },
    }),
    prisma.journalLine.count({ where: { tenantId, ...docFilter } }),
    prisma.expense.count({ where: { tenantId, ...docFilter } }),
    prisma.invoice.count({ where: { tenantId, ...docFilter } }),
    prisma.matchSuggestion.count({ where: { tenantId, ...docFilter } }),
    prisma.partyCategoryStat.count({ where: { tenantId } }),
    prisma.ibanHistory.count({ where: { tenantId } }),
  ]);

  // Como o wipe leva TODOS os documentos do tenant, todas as pastas ficam
  // vazias. Mas nem todas são lixo: `Inbox`/`Despesas`/`Fornecedores` e os
  // seus níveis de data/tipo são a árvore de arquivo e voltam a encher-se.
  // Lixo é o que o folder-routing criou com o NOME de um fornecedor que
  // está a ser apagado — mais tudo o que descende da raiz `Fornecedores`.
  const allFolders = await prisma.folder.findMany({
    where: { tenantId },
    select: { id: true, name: true, parentId: true },
    orderBy: { name: 'asc' },
  });

  const normalize = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  const deletedPartyNames = new Set(partiesToDelete.map((p) => normalize(p.name)));

  const supplierFolderIds = new Set<string>();
  for (const f of allFolders) {
    const isSupplierRoot =
      !f.parentId && !STRUCTURAL_ROOTS.includes(f.name) && deletedPartyNames.has(normalize(f.name));
    const isUnderFornecedores =
      !!f.parentId && allFolders.find((p) => p.id === f.parentId)?.name === 'Fornecedores';
    if (isSupplierRoot || isUnderFornecedores) supplierFolderIds.add(f.id);
  }
  // Descendentes das que já entraram (ex.: "MIRANDA & SERRA, SA - 2026").
  // Itera até estabilizar porque a árvore pode ter mais de um nível.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of allFolders) {
      if (!supplierFolderIds.has(f.id) && f.parentId && supplierFolderIds.has(f.parentId)) {
        supplierFolderIds.add(f.id);
        changed = true;
      }
    }
  }

  const supplierFolders = allFolders
    .filter((f) => supplierFolderIds.has(f.id))
    .map((f) => ({ id: f.id, name: f.name }));
  const structuralFolders = allFolders
    .filter((f) => !supplierFolderIds.has(f.id))
    .map((f) => ({ id: f.id, name: f.name }));

  return {
    tenantId,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    documentIds,
    storageKeys,
    partiesToDelete,
    partiesKept,
    supplierFolders,
    structuralFolders,
    counts: {
      documents: documents.length,
      document_items: items,
      document_field_confirmations: fieldConfirmations,
      approvals,
      payment_events: paymentEvents,
      payment_schedules: paymentSchedules,
      payable_items: payableItems,
      journal_lines: journalLines,
      expenses,
      invoices,
      match_suggestions: matchSuggestions,
      party_category_stats: categoryStats,
      iban_history: ibanHistory,
      parties: partiesToDelete.length,
      storage_objects: storageKeys.length,
    },
  };
}

export interface ResetResult {
  deleted: Record<string, number>;
  storageRemoved: number;
  storageFailed: string[];
}

/**
 * Executa o plano. A ordem respeita as chaves estrangeiras que NÃO têm
 * `onDelete: Cascade` no schema — se alguma destas etapas for removida, o
 * `document.deleteMany` final rebenta com P2003 em vez de apagar.
 */
export async function executeReset(
  prisma: PrismaClient,
  plan: ResetPlan,
  opts: {
    s3?: { client: S3Client; bucket: string };
    folders?: boolean;
    foldersAll?: boolean;
  } = {},
): Promise<ResetResult> {
  const { tenantId, documentIds } = plan;
  const deleted: Record<string, number> = {};
  const partyIds = plan.partiesToDelete.map((p) => p.id);

  await prisma.$transaction(async (tx) => {
    // 1. Auto-referências entre documentos (duplicado → original,
    //    nota de crédito → fatura retificada). Sem isto o delete em
    //    bloco viola a FK que o próprio documento tem para um irmão.
    const unlinked = await tx.document.updateMany({
      where: { tenantId, OR: [{ duplicateOfId: { not: null } }, { correctedDocumentId: { not: null } }] },
      data: { duplicateOfId: null, correctedDocumentId: null },
    });
    deleted['document_self_links_cleared'] = unlinked.count;

    // 2. Dependentes sem cascade. `payments` antes de `invoices` e
    //    `payable_items` porque aponta para ambos.
    const invoiceIds = (
      await tx.invoice.findMany({ where: { tenantId, documentId: { in: documentIds } }, select: { id: true } })
    ).map((i) => i.id);
    const payableIds = (
      await tx.payableItem.findMany({
        where: { tenantId, OR: [{ documentId: { in: documentIds } }, { partyId: { in: partyIds } }] },
        select: { id: true },
      })
    ).map((p) => p.id);

    deleted['payments'] = (
      await tx.payment.deleteMany({
        where: { tenantId, OR: [{ invoiceId: { in: invoiceIds } }, { payableItemId: { in: payableIds } }] },
      })
    ).count;
    deleted['match_suggestions'] = (
      await tx.matchSuggestion.deleteMany({ where: { tenantId, documentId: { in: documentIds } } })
    ).count;
    deleted['journal_lines'] = (
      await tx.journalLine.deleteMany({ where: { tenantId, documentId: { in: documentIds } } })
    ).count;
    deleted['expenses'] = (
      await tx.expense.deleteMany({ where: { tenantId, documentId: { in: documentIds } } })
    ).count;
    deleted['invoices'] = (await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } })).count;
    deleted['payment_schedules'] = (
      await tx.paymentSchedule.deleteMany({ where: { tenantId, documentId: { in: documentIds } } })
    ).count;
    deleted['payable_items'] = (await tx.payableItem.deleteMany({ where: { id: { in: payableIds } } })).count;

    // 3. Documentos. document_items, document_field_confirmations,
    //    approvals e payment_events caem por cascade (FK no schema).
    deleted['documents'] = (await tx.document.deleteMany({ where: { tenantId } })).count;

    // 4. Estado derivado dos documentos que sobreviveria ao wipe e
    //    contaminaria o teste seguinte: os contadores de aprendizagem
    //    (>= 3 aprovações aplicam categoria automaticamente na extração)
    //    e o histórico de IBAN (alimenta o aviso de fraude).
    deleted['party_category_stats'] = (await tx.partyCategoryStat.deleteMany({ where: { tenantId } })).count;
    deleted['iban_history'] = (await tx.ibanHistory.deleteMany({ where: { tenantId } })).count;

    // 5. Entidades criadas pela extração. party_contacts, party_addresses
    //    e o resto caem por cascade.
    deleted['parties'] = partyIds.length
      ? (await tx.party.deleteMany({ where: { tenantId, id: { in: partyIds } } })).count
      : 0;

    // 6. Pastas, só com --folders / --folders-all. Apaga de baixo para
    //    cima: a FK `parent` não tem cascade, por isso um pai apagado
    //    antes do filho dá P2003.
    const folderTargets = opts.foldersAll
      ? [...plan.supplierFolders, ...plan.structuralFolders]
      : opts.folders
        ? plan.supplierFolders
        : [];
    if (folderTargets.length) {
      const rows = await tx.folder.findMany({
        where: { tenantId, id: { in: folderTargets.map((f) => f.id) } },
        select: { id: true, parentId: true },
      });
      const remaining = new Map(rows.map((r) => [r.id, r.parentId]));
      let removed = 0;
      while (remaining.size) {
        const leaves = [...remaining.keys()].filter(
          (id) => ![...remaining.values()].includes(id),
        );
        if (!leaves.length) break; // ciclo inesperado — não insiste
        removed += (await tx.folder.deleteMany({ where: { tenantId, id: { in: leaves } } })).count;
        leaves.forEach((id) => remaining.delete(id));
      }
      deleted['folders'] = removed;
    }
  });

  // 7. Storage, fora da transação: o commit da base de dados é o ponto
  //    de não-retorno e um erro do MinIO não deve reverter o wipe. Um
  //    objeto que falhe fica listado no relatório para remoção à mão.
  let storageRemoved = 0;
  const storageFailed: string[] = [];
  if (opts.s3) {
    for (const key of plan.storageKeys) {
      try {
        await opts.s3.client.send(new DeleteObjectCommand({ Bucket: opts.s3.bucket, Key: key }));
        storageRemoved++;
      } catch (err) {
        storageFailed.push(`${key}: ${(err as Error).message}`);
      }
    }
  }

  return { deleted, storageRemoved, storageFailed };
}

function formatPlan(plan: ResetPlan, opts: { folders: boolean; foldersAll: boolean }): string {
  const out: string[] = [];
  out.push(`Tenant: ${plan.tenantName} (${plan.tenantSlug} / ${plan.tenantId})`);
  out.push('');
  out.push('APAGA:');
  for (const [table, n] of Object.entries(plan.counts)) {
    if (n > 0) out.push(`  ${table.padEnd(30)} ${n}`);
  }
  const folderCount = opts.foldersAll
    ? plan.supplierFolders.length + plan.structuralFolders.length
    : opts.folders
      ? plan.supplierFolders.length
      : 0;
  if (folderCount) out.push(`  ${'folders'.padEnd(30)} ${folderCount}`);
  out.push('');
  out.push(`Entidades apagadas (criadas pela extração) — ${plan.partiesToDelete.length}:`);
  for (const p of plan.partiesToDelete) {
    out.push(`  - ${p.name}${p.nif ? ` (${p.nif})` : ''} — ${p.docs} doc(s)`);
  }
  out.push('');
  out.push(`Entidades PRESERVADAS (criadas à mão / importadas) — ${plan.partiesKept.length}:`);
  for (const p of plan.partiesKept) {
    out.push(`  - ${p.name}${p.nif ? ` (${p.nif})` : ''}`);
  }
  out.push('');
  if (opts.foldersAll) {
    out.push(`Pastas apagadas — TODAS (${folderCount}).`);
  } else if (opts.folders) {
    out.push(`Pastas apagadas (nome de fornecedor) — ${plan.supplierFolders.length}:`);
    out.push(`  ${plan.supplierFolders.map((f) => f.name).join(' | ')}`);
    out.push(`Pastas preservadas (estrutura) — ${plan.structuralFolders.length}:`);
    out.push(`  ${plan.structuralFolders.map((f) => f.name).join(' | ')}`);
  } else {
    out.push(
      `Pastas: nenhuma apagada (usa --folders para as ${plan.supplierFolders.length} de fornecedor).`,
    );
  }
  out.push('');
  out.push('NÃO TOCA: tenant, utilizadores, categorias de despesa, categorias de');
  out.push('fornecedor, plano de contas, regras de pasta, templates CSV, blacklist');
  out.push('de IBAN, auditoria (as linhas existentes ficam; é acrescentada uma).');
  return out.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const slug = argv.find((a) => a.startsWith('--tenant='))?.split('=')[1];
  const apply = args.has('--apply');
  const foldersAll = args.has('--folders-all');
  const folders = args.has('--folders') || foldersAll;
  const keepParties = args.has('--keep-parties');
  const allParties = args.has('--all-parties');

  if (!slug) {
    console.error(
      'Uso: node dist/src/scripts/reset-tenant-documents.js --tenant=<slug> ' +
        '[--apply] [--folders|--folders-all] [--all-parties|--keep-parties]',
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const plan = await buildResetPlan(prisma, slug, { keepParties, allParties });
    console.log(`\n=== reset-tenant-documents — ${apply ? 'EXECUTAR (irreversível)' : 'DRY RUN'} ===\n`);
    console.log(formatPlan(plan, { folders, foldersAll }));

    if (!apply) {
      console.log('\nDry run: nada foi alterado. Repete com --apply para executar.\n');
      return;
    }

    const s3 = process.env.S3_ENDPOINT
      ? {
          client: new S3Client({
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION || 'us-east-1',
            forcePathStyle: true,
            credentials:
              process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
                ? {
                    accessKeyId: process.env.S3_ACCESS_KEY,
                    secretAccessKey: process.env.S3_SECRET_KEY,
                  }
                : undefined,
          }),
          bucket: process.env.S3_BUCKET || 'docflow',
        }
      : undefined;
    if (!s3) console.warn('AVISO: S3_ENDPOINT não definido — os ficheiros NÃO são apagados.');

    const result = await executeReset(prisma, plan, { s3, folders, foldersAll });

    console.log('\n=== RESULTADO ===');
    for (const [table, n] of Object.entries(result.deleted)) {
      if (n > 0) console.log(`  ${table.padEnd(30)} ${n}`);
    }
    console.log(`  ${'storage (objetos)'.padEnd(30)} ${result.storageRemoved}`);
    if (result.storageFailed.length) {
      console.log(`\n  ${result.storageFailed.length} objeto(s) falharam (apagar à mão):`);
      result.storageFailed.forEach((f) => console.log(`    ${f}`));
    }

    // Linha de auditoria pela AuditService para o hash-chain continuar
    // válido — uma escrita crua na tabela partiria a verificação.
    const audit = new AuditService(prisma as unknown as PrismaService);
    await audit.log({
      tenantId: plan.tenantId,
      userId: null,
      action: AuditAction.DELETE,
      entityType: 'tenant',
      entityId: plan.tenantId,
      metadata: {
        subAction: 'tenant.test_data_reset',
        script: 'reset-tenant-documents',
        deleted: result.deleted,
        storageRemoved: result.storageRemoved,
        storageFailed: result.storageFailed.length,
        partiesDeleted: plan.partiesToDelete.map((p) => p.name),
      } as Prisma.InputJsonValue,
    });
    console.log('\nFeito. Linha de auditoria escrita (tenant.test_data_reset).\n');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
