import { DocumentsService } from '../documents.service';

/**
 * Fase 4.1 — regressão real apanhada no smoke de produção.
 *
 * Ao escolher "Mercadorias para revenda" no detalhe, o PATCH devolvia
 * 500 (`TypeError: Cannot read properties of undefined (reading
 * 'reason')`). Causa: a categoria deixou de vir só da lista fixa
 * EXPENSE_CATEGORIES — o operador passou a escolher uma Category real da
 * base de dados — e o lookup da dica de dedutibilidade não tinha guarda
 * para um nome fora dessa lista.
 *
 * A dedutibilidade a sério é calculada por `resolveIvaDeductibility`
 * (natureza + categoria) e gravada em `ivaDeductibilityPct`; a dica na
 * metadata é apenas texto legado.
 */
describe('DocumentsService.writeFilingMetadata() — categorias fora da lista fixa', () => {
  const svc = Object.create(DocumentsService.prototype) as DocumentsService;
  const write = (metadata: unknown, category: string | null) =>
    (svc as unknown as {
      writeFilingMetadata: (m: unknown, p: { expenseCategory: unknown; source: string }) => Record<string, unknown>;
    }).writeFilingMetadata(metadata, { expenseCategory: category, source: 'user' });

  it('não rebenta com uma categoria nova como "Mercadorias para revenda"', () => {
    const out = write(null, 'Mercadorias para revenda');
    const filing = out.filing as Record<string, unknown>;
    expect(filing.expenseCategory).toBe('Mercadorias para revenda');
    expect(filing.vatDeductibilityHint).toBeUndefined();
    expect(filing.source).toBe('user');
  });

  it('aceita as restantes naturezas novas sem lançar', () => {
    for (const name of [
      'Matérias-primas e subsidiárias',
      'Equipamento e imobilizado',
      'Serviços / FSE',
    ]) {
      expect(() => write(null, name)).not.toThrow();
    }
  });

  it('mantém a dica legada nas categorias de despesa que já a tinham', () => {
    const filing = write(null, 'Refeições').filing as Record<string, unknown>;
    expect(filing.expenseCategory).toBe('Refeições');
    expect(typeof filing.vatDeductibilityHint).toBe('string');
  });

  it('apaga a dica antiga ao mudar para uma categoria que não tem dica', () => {
    const first = write(null, 'Refeições');
    const second = write(first, 'Mercadorias para revenda');
    const filing = second.filing as Record<string, unknown>;
    expect(filing.vatDeductibilityHint).toBeUndefined();
  });

  it('limpar a categoria remove-a da metadata junto com a dica', () => {
    const first = write(null, 'Refeições');
    const cleared = write(first, null);
    const filing = cleared.filing as Record<string, unknown>;
    expect(filing.expenseCategory).toBeUndefined();
    expect(filing.vatDeductibilityHint).toBeUndefined();
  });

  it('preserva o resto da metadata que já lá estava', () => {
    const out = write({ extraction: { confidence: 0.9 }, filing: { algo: 'x' } }, 'Comunicações');
    expect((out.extraction as Record<string, unknown>).confidence).toBe(0.9);
    expect((out.filing as Record<string, unknown>).algo).toBe('x');
  });
});
