import { CATEGORY_NATURE_LABEL, resolveIvaDeductibility } from '../iva-deductibility';

/**
 * Fase 4.1 (P1.1) — a HotelEquip é revendedora. Antes só existia
 * "categoria de despesa", o que empurrava compras de mercadoria para
 * categorias de gasto e arrastava com elas as limitações legais dos
 * gastos. A dedutibilidade passa a depender da natureza + categoria.
 */
describe('resolveIvaDeductibility()', () => {
  it('mercadoria para revenda é 100 % dedutível', () => {
    const out = resolveIvaDeductibility('MERCADORIAS_REVENDA');
    expect(out.pct).toBe(100);
    expect(out.needsConfirmation).toBe(false);
  });

  it('matérias-primas e serviços externos são 100 % dedutíveis', () => {
    expect(resolveIvaDeductibility('MATERIAS_PRIMAS_SUBSIDIARIAS').pct).toBe(100);
    expect(resolveIvaDeductibility('SERVICOS_EXTERNOS', 'servicos-fse').pct).toBe(100);
  });

  it('refeições ficam nos 50 % do art. 21.º mesmo dentro de despesa operacional', () => {
    const out = resolveIvaDeductibility('DESPESA_OPERACIONAL', 'refeicoes');
    expect(out.pct).toBe(50);
    expect(out.reason).toContain('21.º');
  });

  it('combustível fica nos 50 % mas marcado para confirmar (gasolina é 0 %)', () => {
    const out = resolveIvaDeductibility('DESPESA_OPERACIONAL', 'combustivel');
    expect(out.pct).toBe(50);
    expect(out.needsConfirmation).toBe(true);
  });

  it('alojamento e deslocações não são dedutíveis por defeito', () => {
    expect(resolveIvaDeductibility('DESPESA_OPERACIONAL', 'alojamento').pct).toBe(0);
    expect(resolveIvaDeductibility('DESPESA_OPERACIONAL', 'deslocacoes').pct).toBe(0);
  });

  it('imobilizado é dedutível, menos viaturas ligeiras de passageiros', () => {
    expect(resolveIvaDeductibility('IMOBILIZADO', 'imobilizado').pct).toBe(100);
    expect(resolveIvaDeductibility('IMOBILIZADO', 'viaturas').pct).toBe(0);
  });

  it('a mesma categoria muda de regra conforme a natureza', () => {
    // A limitação segue a categoria de gasto; a mercadoria nunca é limitada.
    expect(resolveIvaDeductibility('MERCADORIAS_REVENDA', 'refeicoes').pct).toBe(100);
    expect(resolveIvaDeductibility('DESPESA_OPERACIONAL', 'refeicoes').pct).toBe(50);
  });

  it('sem natureza não inventa uma percentagem — marca para confirmação', () => {
    const out = resolveIvaDeductibility(null);
    expect(out.pct).toBe(100);
    expect(out.needsConfirmation).toBe(true);
    expect(out.reason).toContain('Sem natureza');
  });

  it('ignora maiúsculas e espaços no slug da categoria', () => {
    expect(resolveIvaDeductibility('DESPESA_OPERACIONAL', '  Refeicoes ').pct).toBe(50);
  });

  it('tem etiqueta em português para cada natureza', () => {
    expect(Object.keys(CATEGORY_NATURE_LABEL)).toHaveLength(5);
    expect(CATEGORY_NATURE_LABEL.MERCADORIAS_REVENDA).toBe('Mercadorias para revenda');
  });
});
