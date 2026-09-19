import { proposeAccountingEntry } from '../accounting-proposal';

/**
 * Fase 4.2 (P2) — proposta de lançamento determinística. Natureza +
 * regime de IVA decidem as contas; nunca é a IA. Sem um dos dois, não
 * se propõe nada.
 */
describe('proposeAccountingEntry()', () => {
  it('compra nacional de mercadorias — débito 312+2432, crédito 2211', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'PT');
    expect(out.debit.map((l) => l.code)).toEqual(['312', '2432']);
    expect(out.credit.map((l) => l.code)).toEqual(['2211']);
    expect(out.credit[0].amount).toBe('total');
  });

  it('compra intra-UE de mercadorias — autoliquidação: IVA nos dois lados pelo mesmo montante', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'UE_REVERSE_CHARGE');
    expect(out.debit.map((l) => l.code)).toEqual(['312', '2432']);
    expect(out.credit.map((l) => l.code)).toEqual(['2212', '2433']);
    expect(out.credit[0].amount).toBe('net');
    expect(out.credit[1].amount).toBe('tax');
    expect(out.debit[1].amount).toBe('tax');
  });

  it('usa 2212 (fornecedores estrangeiros) para intra-UE, nunca 2211', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'UE_REVERSE_CHARGE');
    expect(out.credit.some((l) => l.code === '2211')).toBe(false);
    expect(out.credit.some((l) => l.code === '2212')).toBe(true);
  });

  it('serviços externos nacional — conta 62 + IVA dedutível', () => {
    const out = proposeAccountingEntry('SERVICOS_EXTERNOS', 'PT');
    expect(out.debit.map((l) => l.code)).toEqual(['62', '2432']);
    expect(out.credit.map((l) => l.code)).toEqual(['2211']);
  });

  it('imobilizado — conta 43', () => {
    const out = proposeAccountingEntry('IMOBILIZADO', 'PT');
    expect(out.debit[0].code).toBe('43');
  });

  it('extra-UE precisa de DUA — não propõe nada, só assinala', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'EXTRA_UE');
    expect(out.debit).toEqual([]);
    expect(out.credit).toEqual([]);
    expect(out.reason).toBe('extra_ue_precisa_dua');
  });

  it('sem natureza, não propõe nada e assinala porquê', () => {
    expect(proposeAccountingEntry(null, 'PT').reason).toBe('sem_natureza_definida');
    expect(proposeAccountingEntry(undefined, 'PT').debit).toEqual([]);
  });

  it('sem regime de IVA, não propõe nada e assinala porquê', () => {
    expect(proposeAccountingEntry('MERCADORIAS_REVENDA', null).reason).toBe('sem_regime_iva_definido');
  });

  it('despesa operacional segue a mesma regra de FSE', () => {
    const pt = proposeAccountingEntry('DESPESA_OPERACIONAL', 'PT');
    expect(pt.debit[0].code).toBe('62');
    const ue = proposeAccountingEntry('DESPESA_OPERACIONAL', 'UE_REVERSE_CHARGE');
    expect(ue.credit.map((l) => l.code)).toEqual(['2212', '2433']);
  });

  it('Fase 4.3 (P1.1) — nota de crédito nacional inverte o lançamento: debita 2211, credita 312 e 2432', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'PT', 'NOTA_CREDITO');
    expect(out.debit.map((l) => l.code)).toEqual(['2211']);
    expect(out.debit[0].amount).toBe('total');
    expect(out.credit.map((l) => l.code)).toEqual(['312', '2432']);
    expect(out.reason).toBe('mercadorias_revenda_pt_nc');
  });

  it('Fase 4.3 (P1.1) — nota de crédito intra-UE inverte ambos os lados de autoliquidação', () => {
    const out = proposeAccountingEntry('MERCADORIAS_REVENDA', 'UE_REVERSE_CHARGE', 'NOTA_CREDITO');
    expect(out.debit.map((l) => l.code)).toEqual(['2212', '2433']);
    expect(out.credit.map((l) => l.code)).toEqual(['312', '2432']);
    expect(out.reason).toBe('mercadorias_revenda_ue_autoliquidacao_nc');
  });
});
