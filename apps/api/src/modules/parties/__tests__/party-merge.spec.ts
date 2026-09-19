import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PartyMergeService } from '../party-merge.service';

/**
 * Fase 4.1 — "fundir entidades" (ADMIN). Corrige em produção o que o
 * `party-identity` passa a impedir: o mesmo fornecedor partido por
 * várias Party. A fusão move o que estava ligado à origem, desativa-a
 * (nunca apaga) e deixa registo na auditoria.
 */
function makeService(parties: Array<Record<string, unknown>>) {
  const calls: Array<{ model: string; args: unknown }> = [];
  const updateMany = (model: string) =>
    jest.fn(async (args: unknown) => {
      calls.push({ model, args });
      return { count: 2 };
    });
  const partyUpdates: Array<Record<string, unknown>> = [];
  const tx = {
    document: { updateMany: updateMany('document') },
    partyContact: { updateMany: updateMany('partyContact') },
    partyAddress: { updateMany: updateMany('partyAddress') },
    ibanHistory: { updateMany: updateMany('ibanHistory') },
    payableItem: { updateMany: updateMany('payableItem') },
    contact: { updateMany: updateMany('contact') },
    partyCategoryStat: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    party: {
      update: jest.fn(async (args: Record<string, unknown>) => {
        partyUpdates.push(args);
        return {};
      }),
    },
  };
  const prisma = {
    party: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) =>
        parties.find((p) => p.id === where.id) ?? null,
      ),
      findMany: jest.fn(async () => parties),
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const svc = new PartyMergeService(prisma as never, audit as never);
  return { svc, prisma, audit, tx, calls, partyUpdates };
}

const CREATEINFOR_WITH_NIF = {
  id: 'p-nif', tenantId: 't1', name: 'CreateInfor', nif: '507298608',
  country: 'PT', notes: null, iban: null, email: null,
};
const CREATEINFOR_NO_NIF = {
  id: 'p-orphan', tenantId: 't1', name: 'CreateInfor, Lda', nif: null,
  country: 'PT', notes: 'nota antiga', iban: 'PT50000201231234567890154', email: null,
};
const OLITREM = {
  id: 'p-other', tenantId: 't1', name: 'Olitrem, S.A.', nif: '501775471',
  country: 'PT', notes: null, iban: null, email: null,
};

describe('PartyMergeService.merge()', () => {
  it('move documentos, contactos, moradas, IBANs e histórico da origem para o destino', async () => {
    const { svc, calls } = makeService([CREATEINFOR_WITH_NIF, CREATEINFOR_NO_NIF]);
    const out = await svc.merge('t1', 'u1', 'p-nif', 'p-orphan');
    const models = calls.map((c) => c.model);
    expect(models).toEqual(
      expect.arrayContaining(['document', 'partyContact', 'partyAddress', 'ibanHistory']),
    );
    for (const c of calls) {
      expect(c.args).toEqual({ where: { partyId: 'p-orphan' }, data: { partyId: 'p-nif' } });
    }
    expect(out.moved.document).toBe(2);
  });

  it('o destino adota os campos que tinha vazios (a fusão não perde dados)', async () => {
    const { svc, partyUpdates } = makeService([CREATEINFOR_WITH_NIF, CREATEINFOR_NO_NIF]);
    const out = await svc.merge('t1', 'u1', 'p-nif', 'p-orphan');
    expect(out.adopted).toContain('iban');
    const inherit = partyUpdates.find((u) => (u.where as { id: string }).id === 'p-nif');
    expect((inherit?.data as Record<string, unknown>).iban).toBe(CREATEINFOR_NO_NIF.iban);
  });

  it('desativa a origem mas NUNCA a apaga — o histórico fiscal tem de sobreviver', async () => {
    const { svc, partyUpdates, tx } = makeService([CREATEINFOR_WITH_NIF, CREATEINFOR_NO_NIF]);
    await svc.merge('t1', 'u1', 'p-nif', 'p-orphan');
    const deactivate = partyUpdates.find((u) => (u.where as { id: string }).id === 'p-orphan');
    const data = deactivate?.data as Record<string, unknown>;
    expect(data.isActive).toBe(false);
    expect(String(data.notes)).toContain('nota antiga'); // nota anterior preservada
    expect(String(data.notes)).toContain('Fundida em CreateInfor');
    expect((tx.party as { delete?: unknown }).delete).toBeUndefined();
  });

  it('regista a fusão na auditoria com origem, destino e o que foi movido', async () => {
    const { svc, audit } = makeService([CREATEINFOR_WITH_NIF, CREATEINFOR_NO_NIF]);
    await svc.merge('t1', 'u1', 'p-nif', 'p-orphan');
    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.entityType).toBe('Party');
    expect(entry.entityId).toBe('p-nif');
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.operation).toBe('merge');
    expect(meta.sourceId).toBe('p-orphan');
    expect(meta.sourceName).toBe('CreateInfor, Lda');
  });

  it('recusa fundir fornecedores diferentes — misturava faturas na contabilidade', async () => {
    const { svc } = makeService([CREATEINFOR_WITH_NIF, OLITREM]);
    await expect(svc.merge('t1', 'u1', 'p-nif', 'p-other')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('recusa fundir uma entidade consigo própria e erra em ids desconhecidos', async () => {
    const { svc } = makeService([CREATEINFOR_WITH_NIF]);
    await expect(svc.merge('t1', 'u1', 'p-nif', 'p-nif')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.merge('t1', 'u1', 'p-nif', 'p-nao-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('aceita duas entidades com o mesmo NIF mesmo com nomes diferentes', async () => {
    const twin = { ...CREATEINFOR_NO_NIF, id: 'p-twin', name: 'Outro nome', nif: '507298608' };
    const { svc } = makeService([CREATEINFOR_WITH_NIF, twin]);
    await expect(svc.merge('t1', 'u1', 'p-nif', 'p-twin')).resolves.toMatchObject({
      targetId: 'p-nif',
      sourceId: 'p-twin',
    });
  });
});

describe('PartyMergeService.findDuplicates()', () => {
  it('agrupa as três CreateInfor e sugere como destino a que tem NIF', async () => {
    const third = { ...CREATEINFOR_NO_NIF, id: 'p-orphan2', name: 'CREATEINFOR' };
    const { svc } = makeService([CREATEINFOR_NO_NIF, third, CREATEINFOR_WITH_NIF, OLITREM]);
    const out = await svc.findDuplicates('t1');
    expect(out.groups).toHaveLength(1);
    const group = out.groups[0];
    expect(group.parties).toHaveLength(3);
    expect(group.suggestedTargetId).toBe('p-nif');
    expect(group.key).toBe('nif:507298608');
  });

  it('não devolve grupos quando não há duplicados', async () => {
    const { svc } = makeService([OLITREM]);
    expect((await svc.findDuplicates('t1')).groups).toEqual([]);
  });
});
