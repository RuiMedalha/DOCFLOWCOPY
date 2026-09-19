import { isSamePartyName, normalizePartyName, partyNameKey } from '../party-identity';

/**
 * Fase 4.1 — o teste real do Rui encontrou o mesmo fornecedor espalhado
 * por várias entidades. Em produção existiam três Party chamadas
 * "CreateInfor" (nif=null, 507298608, nif=null) porque um NIF mal lido
 * pela IA não passava o módulo 11, não era gravado, e a procura seguinte
 * por NIF não encontrava nada. O nome normalizado é a chave secundária.
 */
describe('normalizePartyName()', () => {
  it('remove acentos, pontuação e formas jurídicas', () => {
    expect(normalizePartyName('MIRANDA & SERRA, SA')).toBe('MIRANDA E SERRA');
    expect(normalizePartyName('Olitrem -Indústria de Refrigeração, S.A.')).toBe(
      'OLITREM INDUSTRIA DE REFRIGERACAO',
    );
    expect(normalizePartyName('TEFCOLD ES, S.L.')).toBe('TEFCOLD ES');
    expect(normalizePartyName('CATERING SUPPLIES LTD')).toBe('CATERING SUPPLIES');
  });

  it('casa as três CreateInfor que ficaram partidas em produção', () => {
    const variants = ['CreateInfor', 'CREATEINFOR', 'Createinfor, Lda', 'Create Infor'];
    const normalized = variants.map(normalizePartyName);
    // As três primeiras são a mesma entidade; "Create Infor" (com espaço)
    // é propositadamente diferente — não inventamos correspondências.
    expect(normalized[0]).toBe('CREATEINFOR');
    expect(normalized[1]).toBe('CREATEINFOR');
    expect(normalized[2]).toBe('CREATEINFOR');
    expect(normalized[3]).toBe('CREATE INFOR');
  });

  it('casa as variantes da SAMMIC que apareceram nas faturas', () => {
    expect(
      isSamePartyName('SAMMIC-EQUIP.DE HOTELAIRA LDA.', 'Sammic Equip de Hotelaira, Lda'),
    ).toBe(true);
  });

  it('remove UNIPESSOAL / SOCIEDADE / GMBH / BV / S. Coop.', () => {
    expect(normalizePartyName('BP Espinheira Tjsr-Combustiveis, Unipessoal, Lda')).toBe(
      'BP ESPINHEIRA TJSR COMBUSTIVEIS',
    );
    expect(normalizePartyName('Onnera Group S. Coop.')).toBe('ONNERA');
    expect(normalizePartyName('Müller Handels GmbH')).toBe('MULLER HANDELS');
    expect(normalizePartyName('Van Dijk Horeca BV')).toBe('VAN DIJK HORECA');
  });

  it('devolve string vazia quando não sobra nada distintivo', () => {
    expect(normalizePartyName('Lda.')).toBe('');
    expect(normalizePartyName('S.A.')).toBe('');
    expect(normalizePartyName('   ')).toBe('');
    expect(normalizePartyName(null)).toBe('');
    expect(normalizePartyName(undefined)).toBe('');
  });

  it('não casa fornecedores diferentes', () => {
    expect(isSamePartyName('SAMMIC', 'OLITREM')).toBe(false);
    expect(isSamePartyName('Lda', 'SA')).toBe(false); // ambos vazios → nunca casam
  });
});

describe('partyNameKey()', () => {
  it('junta país + nome normalizado', () => {
    expect(partyNameKey('TEFCOLD ES, S.L.', 'ES')).toBe('ES:TEFCOLD ES');
    expect(partyNameKey('Olitrem, S.A.', 'pt')).toBe('PT:OLITREM');
  });

  it('não emite chave sem país — casar SAMMIC de ES com SAMMIC de PT seria pior', () => {
    expect(partyNameKey('SAMMIC', null)).toBeNull();
    expect(partyNameKey('SAMMIC', 'Portugal')).toBeNull();
  });

  it('não emite chave quando o nome não sobrevive à normalização', () => {
    expect(partyNameKey('Lda.', 'PT')).toBeNull();
  });
});
