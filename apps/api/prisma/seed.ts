import { PrismaClient, Role, AccountType, PartyType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ACCOUNTS: Array<{ code: string; name: string; type: AccountType }> = [
  { code: '21', name: 'Clientes', type: AccountType.ASSET },
  { code: '221', name: 'Fornecedores c/c', type: AccountType.LIABILITY },
  { code: '31', name: 'Compras', type: AccountType.EXPENSE },
  { code: '62', name: 'Fornecimentos e serviços externos', type: AccountType.EXPENSE },
  { code: '2432', name: 'IVA dedutível', type: AccountType.ASSET },
  { code: '12', name: 'Depósitos à ordem', type: AccountType.ASSET },
  { code: '71', name: 'Vendas', type: AccountType.REVENUE },
  { code: '72', name: 'Prestações de serviços', type: AccountType.REVENUE },
];

async function main() {
  console.log('Seeding DocFlow demo data...');
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: { name: 'NOV OUSADO UNIPESSOAL LDA', nif: '515208566', country: 'PT' },
    create: {
      name: 'NOV OUSADO UNIPESSOAL LDA', slug: 'demo', nif: '515208566', country: 'PT',
      iban: 'PT50003506510000000000712', bic: 'CGDIPTPL', bankName: 'Caixa Geral de Depósitos',
    },
  });

  const passwordHash = await bcrypt.hash('Admin123!', 12);
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@demo.pt' } },
    update: { passwordHash, name: 'Admin Demo', role: Role.ADMIN, isActive: true },
    create: {
      tenantId: tenant.id, email: 'admin@demo.pt', passwordHash,
      name: 'Admin Demo', role: Role.ADMIN, canViewBankValues: true,
      canViewReconciliation: true, canApprovePayments: true, canExportData: true,
      canManagePayroll: true, canManageIntegrations: true,
    },
  });

  // Sprint 1.B — Approver demo user. The role already exists in the
  // `Role` enum (APPROVER); we just materialise a row the UI can
  // use to exercise the approval-decision endpoints. Same password
  // as ADMIN for the demo fixture — production uses SSO + per-user
  // secrets.
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'approver@demo.pt' } },
    update: { passwordHash, name: 'Approver Demo', role: Role.APPROVER, isActive: true },
    create: {
      tenantId: tenant.id, email: 'approver@demo.pt', passwordHash,
      name: 'Approver Demo', role: Role.APPROVER, canApprovePayments: true,
    },
  });

  for (const account of ACCOUNTS) {
    await prisma.account.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: account.code } },
      update: { name: account.name, type: account.type, isActive: true },
      create: { tenantId: tenant.id, ...account },
    });
  }

  const account62 = await prisma.account.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code: '62' } } });
  const account221 = await prisma.account.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code: '221' } } });
  await prisma.party.upsert({
    where: { id: 'seed-party-fornecedor' }, update: {},
    create: { id: 'seed-party-fornecedor', tenantId: tenant.id, type: PartyType.FORNECEDOR,
      name: 'Fornecedor Demo Lda', nif: '500000001', email: 'fornecedor@demo.pt',
      iban: 'PT50000700000000000000000', city: 'Lisboa', paymentTermDays: 30,
      defaultDebitAccountId: account62?.id, defaultCreditAccountId: account221?.id },
  });
  await prisma.party.upsert({
    where: { id: 'seed-party-cliente' }, update: {},
    create: { id: 'seed-party-cliente', tenantId: tenant.id, type: PartyType.CLIENTE,
      name: 'Cliente Demo SA', nif: '501000002', email: 'cliente@demo.pt',
      iban: 'PT50003506510000000000712', city: 'Porto', paymentTermDays: 30 },
  });

  const rules = [
    { id: 'seed-folder-rule-default', name: 'Padrão por ano/mês/tipo', priority: 0,
      conditions: {}, folderPattern: '/{Ano}/{Mes}/{Tipo}/{Entidade}' },
    { id: 'seed-folder-rule-supplier', name: 'Faturas de fornecedores', priority: 10,
      conditions: { type: 'FATURA_RECEBIDA' }, folderPattern: '/{Ano}/{Mes}/Recebidas/{Entidade}' },
    { id: 'seed-folder-rule-customer', name: 'Faturas emitidas', priority: 20,
      conditions: { type: 'FATURA_EMITIDA' }, folderPattern: '/{Ano}/{Mes}/Emitidas/{Entidade}' },
  ];
  for (const rule of rules) {
    await prisma.folderRule.upsert({
      where: { id: rule.id },
      update: { name: rule.name, priority: rule.priority, conditions: rule.conditions, folderPattern: rule.folderPattern, isActive: true },
      create: { ...rule, tenantId: tenant.id, isActive: true },
    });
  }
  console.log(`Seed complete: tenant=${tenant.slug}, accounts=${ACCOUNTS.length}, parties=2, folderRules=${rules.length}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
