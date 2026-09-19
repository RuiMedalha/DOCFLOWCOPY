import {
  buildEnterpriseFilingPath,
  resolveEnterpriseFolder,
} from '../path-builder';

describe('Enterprise Filing Path (Fase 4.6 P1)', () => {
  const sampleDate = new Date('2026-09-15T10:00:00Z');
  const sampleDueDate = new Date('2026-10-15T10:00:00Z');

  it('routes approved unpaid invoice to FORNECEDORES/FATURAS A PAGAR/<FORNECEDOR>/', () => {
    const path = buildEnterpriseFilingPath({
      isPaid: false,
      supplierName: 'EDP Comercial',
      partySlug: 'edp-comercial',
      docType: 'FATURA',
      docNumber: '102030',
      docDate: sampleDate,
      dueDate: sampleDueDate,
      amount: 250.5,
      extension: 'pdf',
    });

    expect(path).toBe(
      'FORNECEDORES/FATURAS A PAGAR/EDP Comercial/FT_102030_EDPComercial_250.50EUR_2026-10-15.pdf',
    );
  });

  it('routes paid invoice to FORNECEDORES/COMPRAS/<FORNECEDOR>/<ANO>/', () => {
    const path = buildEnterpriseFilingPath({
      isPaid: true,
      supplierName: 'EDP Comercial',
      partySlug: 'edp-comercial',
      docType: 'FATURA',
      docNumber: '102030',
      docDate: sampleDate,
      dueDate: sampleDueDate,
      amount: 250.5,
      extension: 'pdf',
    });

    expect(path).toBe(
      'FORNECEDORES/COMPRAS/EDP Comercial/2026/FT_102030_EDPComercial_250.50EUR_2026-10-15.pdf',
    );
  });

  it('routes Makro to MAKRO/<ANO>/', () => {
    const folder = resolveEnterpriseFolder({
      isPaid: false,
      supplierName: 'MAKRO Cash & Carry',
      docDate: sampleDate,
    });
    expect(folder).toBe('MAKRO/2026');
  });

  it('routes Renda to RENDA/<ANO>/', () => {
    const folder = resolveEnterpriseFolder({
      isPaid: false,
      categoryName: 'Renda e Condomínio',
      natureza: 'RENDA',
      docDate: sampleDate,
    });
    expect(folder).toBe('RENDA/2026');
  });

  it('routes Seguros to specific subtype folder (e.g. SEGURO DE SAUDE)', () => {
    const folder = resolveEnterpriseFolder({
      isPaid: false,
      categoryName: 'Seguro de Saúde Multicare',
      natureza: 'SEGUROS',
      docDate: sampleDate,
    });
    expect(folder).toBe('SEGURO DE SAUDE/2026');
  });

  it('routes Funcionários and Pagamentos ao Estado correctly', () => {
    const folEst = resolveEnterpriseFolder({
      isPaid: false,
      natureza: 'PAGAMENTOS_AO_ESTADO',
      docDate: sampleDate,
    });
    expect(folEst).toBe('PAGAMENTOS AO ESTADO/2026');

    const folFunc = resolveEnterpriseFolder({
      isPaid: false,
      natureza: 'FUNCIONARIOS',
      docDate: sampleDate,
    });
    expect(folFunc).toBe('FUNCIONARIOS/2026');
  });
});
