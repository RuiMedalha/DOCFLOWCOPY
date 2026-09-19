import { isGenericPartyName, parsePostalAddress } from '../address-parser';

/**
 * Fase 4.2 (P1.1) — o painel já mostrava "Morada (VIES)" corretamente,
 * mas os dados nunca chegavam aos campos reais da entidade. Esta função
 * resolve a parte de partir a morada; a escrita fica em vies.service.ts.
 */
describe('parsePostalAddress()', () => {
  it('reconhece o formato PT (o caso real do IKEA)', () => {
    const out = parsePostalAddress('RUA 28 DE SETEMBRO, EN 250\nFRIELAS\n2660-001 FRIELAS');
    expect(out.postalCode).toBe('2660-001');
    expect(out.city).toBe('FRIELAS');
    expect(out.address).toBe('RUA 28 DE SETEMBRO, EN 250, FRIELAS');
  });

  it('reconhece o formato ES', () => {
    const out = parsePostalAddress('CALLE MAYOR 1\n28001 MADRID');
    expect(out.postalCode).toBe('28001');
    expect(out.city).toBe('MADRID');
  });

  it('reconhece o formato DE numa única linha preservando a rua', () => {
    const out = parsePostalAddress('Hauptstrasse 1, 10115 Berlin');
    expect(out.postalCode).toBe('10115');
    expect(out.city).toBe('Berlin');
    expect(out.address).toBe('Hauptstrasse 1');
  });

  it('reconhece o formato PT numa única linha preservando a rua', () => {
    const out = parsePostalAddress('Rua das Flores 123, 2660-001 FRIELAS');
    expect(out.postalCode).toBe('2660-001');
    expect(out.city).toBe('FRIELAS');
    expect(out.address).toBe('Rua das Flores 123');
  });

  it('limpa cidade colada ao fim da morada (caso real da AT / AZUR NET)', () => {
    const out = parsePostalAddress('R CAMBO LES BAINS N 3 RC ESQCALDAS DA RAINHA2500-326 CALDAS DA RAINHA');
    expect(out.postalCode).toBe('2500-326');
    expect(out.city).toBe('CALDAS DA RAINHA');
    expect(out.address).toBe('R CAMBO LES BAINS N 3 RC ESQ');
  });

  it('limpa cidade colada ao fim da morada com espaco antes do codigo postal', () => {
    const out = parsePostalAddress('R CAMBO LES BAINS N 3 RC ESQCALDAS DA RAINHA 2500-326 CALDAS DA RAINHA');
    expect(out.postalCode).toBe('2500-326');
    expect(out.city).toBe('CALDAS DA RAINHA');
    expect(out.address).toBe('R CAMBO LES BAINS N 3 RC ESQ');
  });

  it('remove a província entre parênteses do formato ES', () => {
    const out = parsePostalAddress('28001 MADRID (MADRID)');
    expect(out.city).toBe('MADRID');
  });

  it('sem código postal reconhecível, a última linha fica como cidade quando há mais do que uma', () => {
    const out = parsePostalAddress('Rua Principal\nVila Nova');
    expect(out.postalCode).toBeNull();
    expect(out.city).toBe('Vila Nova');
    expect(out.address).toBe('Rua Principal');
  });

  it('uma única linha sem código postal fica toda em address', () => {
    const out = parsePostalAddress('Sem código postal nenhum aqui');
    expect(out.postalCode).toBeNull();
    expect(out.city).toBeNull();
    expect(out.address).toBe('Sem código postal nenhum aqui');
  });

  it('devolve tudo null para uma morada vazia ou ausente', () => {
    expect(parsePostalAddress(null)).toEqual({ address: null, postalCode: null, city: null });
    expect(parsePostalAddress('')).toEqual({ address: null, postalCode: null, city: null });
    expect(parsePostalAddress('   ')).toEqual({ address: null, postalCode: null, city: null });
  });
});

describe('isGenericPartyName()', () => {
  it('reconhece o sentinela "Fornecedor por identificar"', () => {
    expect(isGenericPartyName('Fornecedor por identificar')).toBe(true);
    expect(isGenericPartyName('fornecedor por identificar')).toBe(true);
  });

  it('reconhece um nome vazio', () => {
    expect(isGenericPartyName('')).toBe(true);
    expect(isGenericPartyName(null)).toBe(true);
    expect(isGenericPartyName(undefined)).toBe(true);
  });

  it('reconhece o NIF ou o NIF-IVA repetidos como nome', () => {
    expect(isGenericPartyName('505416654', '505416654')).toBe(true);
    expect(isGenericPartyName('ESB20869152', null, 'ESB20869152')).toBe(true);
  });

  it('reconhece traços, pontos ou sentinelas de VIES como "---"', () => {
    expect(isGenericPartyName('---')).toBe(true);
    expect(isGenericPartyName('--')).toBe(true);
    expect(isGenericPartyName('-')).toBe(true);
    expect(isGenericPartyName(' - ')).toBe(true);
    expect(isGenericPartyName('...')).toBe(true);
    expect(isGenericPartyName('N/A')).toBe(true);
    expect(isGenericPartyName('desconhecido')).toBe(true);
  });

  it('não mexe num nome real, mesmo que pareça estranho', () => {
    expect(isGenericPartyName('IKEA PORTUGAL MOVEIS E DECORAÇÃO LDA', '505416654')).toBe(false);
    expect(isGenericPartyName('SAMMIC EQUIP. DE HOTELARIA LDA')).toBe(false);
    expect(isGenericPartyName('GARCIA DE POU S.A.')).toBe(false);
  });
});
