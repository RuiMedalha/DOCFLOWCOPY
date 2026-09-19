import { classifyLineDiscount } from '../line-discount';

/**
 * Fase 4.2 (P0.3) — a SAMMIC imprime "Dto. 30,00" numa linha (2 ×
 * 24,10 = 48,20; menos 30% = 33,74) e o sistema tratava-o como €30,00,
 * chegando a 18,20. A classificação deduz o tipo pela aritmética,
 * usando o total da linha como prova.
 */
describe('classifyLineDiscount()', () => {
  it('reconhece a SAMMIC: "Dto. 30,00" é 30%, não 30€', () => {
    const out = classifyLineDiscount({ quantity: 2, unitPrice: 24.1, discount: 30, lineTotal: 33.74 });
    expect(out.kind).toBe('percent');
    expect(out.discountPercent).toBe(30);
    expect(out.discountAmount).toBeCloseTo(14.46, 2); // 48.20 * 0.30
  });

  it('reconhece um desconto em valor quando só a subtração bate certo', () => {
    // 90 − 10 = 80 (subtração bate); 90 × 0,9 = 81 (percentagem não bate).
    const out = classifyLineDiscount({ quantity: 1, unitPrice: 90, discount: 10, lineTotal: 80 });
    expect(out.kind).toBe('amount');
    expect(out.discountAmount).toBe(10);
  });

  it('distingue os dois casos quando dariam resultados diferentes', () => {
    // 2 × 50 = 100. Desconto "20": por valor dá 80; por percentagem dá 80 também
    // (coincidência) — usar um caso que os separe de verdade.
    const asAmount = classifyLineDiscount({ quantity: 3, unitPrice: 40, discount: 20, lineTotal: 100 });
    expect(asAmount.kind).toBe('amount'); // 120 - 20 = 100
    const asPercent = classifyLineDiscount({ quantity: 3, unitPrice: 40, discount: 20, lineTotal: 96 });
    expect(asPercent.kind).toBe('percent'); // 120 * 0.8 = 96
  });

  it('sem total de linha, mantém o comportamento anterior (trata como euros)', () => {
    const out = classifyLineDiscount({ quantity: 2, unitPrice: 24.1, discount: 30 });
    expect(out.kind).toBe('unknown');
    expect(out.discountAmount).toBe(30);
    expect(out.discountPercent).toBeNull();
  });

  it('sem desconto nenhum, devolve "none" e nada mais', () => {
    expect(classifyLineDiscount({ quantity: 1, unitPrice: 10, lineTotal: 10 })).toEqual({
      kind: 'none',
      discountPercent: null,
      discountAmount: null,
    });
    expect(classifyLineDiscount({ discount: 0, lineTotal: 10 }).kind).toBe('none');
  });

  it('quando nenhuma interpretação bate certo, escolhe a que menos se afasta', () => {
    // 2 × 50 = 100. Nem 100-15=85 nem 100*0.85=85 batem com 70 real
    // (dados inconsistentes) — ainda assim devolve algo plausível.
    const out = classifyLineDiscount({ quantity: 2, unitPrice: 50, discount: 15, lineTotal: 70 });
    expect(['percent', 'amount']).toContain(out.kind);
    expect(out.discountAmount).not.toBeNull();
  });

  it('aceita 1 cêntimo de folga (dois fatores acumulam mais erro)', () => {
    const out = classifyLineDiscount({ quantity: 3, unitPrice: 33.33, discount: 10, lineTotal: 89.99 });
    // 3*33.33=99.99; *0.9=89.991 → arredonda para 89.99
    expect(out.kind).toBe('percent');
  });
});
