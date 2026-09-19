import { buildDocumentPath } from '../path-builder';

/**
 * Pure-function tests for the deterministic folder-routing helper.
 * Same input → same output is the contract; dedup + idempotency rely on it.
 */
describe('buildDocumentPath', () => {
  const baseInput = {
    documentDate: new Date(Date.UTC(2026, 8, 4)), // 2026-09 (month is 0-indexed)
    documentNumber: 'FT 2026/123',
    fileId: 'cm1234567890abcdef',
    extension: 'pdf',
  };

  it('routes FORNECEDOR + party + no category to fornecedores/<slug>/<YYYY-MM>/', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'edp-comercial',
      partyCategorySlug: null,
    });
    expect(path).toBe('fornecedores/edp-comercial/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('routes CLIENTE + party + no category to clientes/<slug>/<YYYY-MM>/', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'CLIENTE',
      partySlug: 'lisbon-hotels',
      partyCategorySlug: null,
    });
    expect(path).toBe('clientes/lisbon-hotels/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('routes AMBOS to fornecedores/<slug>/ (per product decision)', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'AMBOS',
      partySlug: 'grupo-misto',
      partyCategorySlug: null,
    });
    expect(path).toBe('fornecedores/grupo-misto/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('nests category inside the party folder when supplied', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'aws',
      partyCategorySlug: 'estrategico',
    });
    expect(path).toBe('fornecedores/aws/estrategico/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('falls back to despesas/<YYYY-MM>/ when no party', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: null,
      partySlug: null,
      partyCategorySlug: null,
    });
    expect(path).toBe('despesas/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('falls back to despesas/ when partyType is set but partySlug is null', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: null,
      partyCategorySlug: null,
    });
    expect(path).toBe('despesas/2026-09/ft-2026-123-cm123456.pdf');
  });

  it('sanitises doc numbers with `/` and spaces', () => {
    const path = buildDocumentPath({
      ...baseInput,
      documentNumber: 'FT 2026/123 A',
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: null,
    });
    // Final filename uses `ft-2026-123-a-`
    expect(path).toMatch(/^fornecedores\/edp\/2026-09\/ft-2026-123-a-/);
  });

  it('uses "unnumbered" when documentNumber is empty / missing', () => {
    const path = buildDocumentPath({
      ...baseInput,
      documentNumber: '',
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: null,
    });
    expect(path).toBe('fornecedores/edp/2026-09/unnumbered-cm123456.pdf');
  });

  it('uses 8-char fileId prefix for the filename', () => {
    const path = buildDocumentPath({
      ...baseInput,
      fileId: 'abcdef1234567890',
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: null,
    });
    expect(path.endsWith('-abcdef12.pdf')).toBe(true);
  });

  it('strips a leading dot from the extension', () => {
    const path = buildDocumentPath({
      ...baseInput,
      extension: '.pdf',
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: null,
    });
    expect(path.endsWith('.pdf')).toBe(true);
  });

  it('produces identical output for identical input (deterministic)', () => {
    const a = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: 'estrategico',
    });
    const b = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: 'estrategico',
    });
    expect(a).toBe(b);
  });

  it('bucket month is UTC even when the Date has a non-UTC wall clock', () => {
    const path = buildDocumentPath({
      ...baseInput,
      documentDate: new Date('2026-01-31T23:30:00Z'), // 2026-01 UTC
      partyType: 'FORNECEDOR',
      partySlug: 'edp',
      partyCategorySlug: null,
    });
    expect(path).toContain('/2026-01/');
  });

  it('generates standardized filename {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf and year folder', () => {
    const path = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'nome-fornecedor',
      partyCategorySlug: null,
      docType: 'FATURA',
      supplierName: 'Nome Fornecedor',
      documentNumber: 'FT2026-102',
      documentDate: new Date('2026-09-09T10:00:00Z'),
      yearOnly: true,
    });
    expect(path).toBe('fornecedores/nome-fornecedor/2026/FT_NomeFornecedor_FT2026-102_2026-09-09.pdf');
  });

  it('generates standardized acronyms: FR (Fatura-Recibo), NC (Nota Crédito), ND (Nota Débito)', () => {
    const frPath = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'posto-combustivel',
      partyCategorySlug: null,
      docType: 'FATURA_RECIBO',
      supplierName: 'Galp',
      documentNumber: 'FR 2026/99',
      documentDate: new Date('2026-09-09T10:00:00Z'),
      yearOnly: true,
    });
    expect(frPath).toBe('fornecedores/posto-combustivel/2026/FR_Galp_FR2026-99_2026-09-09.pdf');

    const ncPath = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'fornecedor-x',
      partyCategorySlug: null,
      docType: 'NOTA_CREDITO',
      supplierName: 'Fornecedor X',
      documentNumber: 'NC-10',
      documentDate: new Date('2026-09-09T10:00:00Z'),
      yearOnly: true,
    });
    expect(ncPath).toBe('fornecedores/fornecedor-x/2026/NC_FornecedorX_NC-10_2026-09-09.pdf');

    const ndPath = buildDocumentPath({
      ...baseInput,
      partyType: 'FORNECEDOR',
      partySlug: 'fornecedor-x',
      partyCategorySlug: null,
      docType: 'NOTA_DEBITO',
      supplierName: 'Fornecedor X',
      documentNumber: 'ND-20',
      documentDate: new Date('2026-09-09T10:00:00Z'),
      yearOnly: true,
    });
    expect(ndPath).toBe('fornecedores/fornecedor-x/2026/ND_FornecedorX_ND-20_2026-09-09.pdf');
  });
});
