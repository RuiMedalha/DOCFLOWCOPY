import {
  generateStandardFileName,
  mapDocTypeToSigla,
  sanitizeSupplierForFileName,
  sanitizeDocNumberForFileName,
  formatDateForFileName,
} from '../filename-standardizer';

describe('filename-standardizer', () => {
  describe('mapDocTypeToSigla', () => {
    it('maps FATURA / FT to FT', () => {
      expect(mapDocTypeToSigla('FATURA')).toBe('FT');
      expect(mapDocTypeToSigla('FATURA_RECEBIDA')).toBe('FT');
      expect(mapDocTypeToSigla('FT')).toBe('FT');
    });

    it('maps FATURA_RECIBO / SIMPLIFICADA to FR', () => {
      expect(mapDocTypeToSigla('FATURA_RECIBO')).toBe('FR');
      expect(mapDocTypeToSigla('FATURA_SIMPLIFICADA')).toBe('FR');
      expect(mapDocTypeToSigla('FR')).toBe('FR');
      expect(mapDocTypeToSigla('FS')).toBe('FR');
    });

    it('maps NOTA_CREDITO / NC to NC', () => {
      expect(mapDocTypeToSigla('NOTA_CREDITO')).toBe('NC');
      expect(mapDocTypeToSigla('NC')).toBe('NC');
    });

    it('maps NOTA_DEBITO / ND to ND', () => {
      expect(mapDocTypeToSigla('NOTA_DEBITO')).toBe('ND');
      expect(mapDocTypeToSigla('ND')).toBe('ND');
    });

    it('falls back to FT for empty/null', () => {
      expect(mapDocTypeToSigla(null)).toBe('FT');
      expect(mapDocTypeToSigla(undefined)).toBe('FT');
      expect(mapDocTypeToSigla('')).toBe('FT');
    });
  });

  describe('sanitizeSupplierForFileName', () => {
    it('cleans accents and converts to PascalCase', () => {
      expect(sanitizeSupplierForFileName('Nome Fornecedor, Lda.')).toBe('NomeFornecedorLda');
      expect(sanitizeSupplierForFileName('Águas de Portugal, S.A.')).toBe('AguasDePortugalSA');
      expect(sanitizeSupplierForFileName('EDP Comercial')).toBe('EDPComercial');
    });

    it('falls back to Fornecedor for empty names', () => {
      expect(sanitizeSupplierForFileName(null)).toBe('Fornecedor');
      expect(sanitizeSupplierForFileName('')).toBe('Fornecedor');
      expect(sanitizeSupplierForFileName('   ')).toBe('Fornecedor');
    });
  });

  describe('sanitizeDocNumberForFileName', () => {
    it('cleans slashes, spaces and special characters', () => {
      expect(sanitizeDocNumberForFileName('FT 2026/102')).toBe('FT2026-102');
      expect(sanitizeDocNumberForFileName('FAT/2026_01')).toBe('FAT-2026_01');
    });

    it('falls back to SN when missing', () => {
      expect(sanitizeDocNumberForFileName(null)).toBe('SN');
      expect(sanitizeDocNumberForFileName('')).toBe('SN');
    });
  });

  describe('formatDateForFileName', () => {
    it('formats date as YYYY-MM-DD', () => {
      expect(formatDateForFileName(new Date('2026-09-09T14:30:00Z'))).toBe('2026-09-09');
      expect(formatDateForFileName('2026-09-09')).toBe('2026-09-09');
    });
  });

  describe('generateStandardFileName', () => {
    it('generates standard format: {TIPO}_{FORNECEDOR}_{NUMERO}_{DATA}.pdf', () => {
      const result = generateStandardFileName({
        type: 'FATURA',
        supplier: 'Nome Fornecedor',
        docNumber: 'FT2026-102',
        docDate: new Date('2026-09-09T10:00:00Z'),
        extension: 'pdf',
      });
      expect(result).toBe('FT_NomeFornecedor_FT2026-102_2026-09-09.pdf');
    });

    it('handles Fatura-Recibo, Nota de Crédito, Nota de Débito', () => {
      expect(
        generateStandardFileName({
          type: 'FATURA_RECIBO',
          supplier: 'Galp Energia',
          docNumber: 'FR 2026/55',
          docDate: '2026-08-15',
        }),
      ).toBe('FR_GalpEnergia_FR2026-55_2026-08-15.pdf');

      expect(
        generateStandardFileName({
          type: 'NOTA_CREDITO',
          supplier: 'Vodafone',
          docNumber: 'NC-99',
          docDate: '2026-07-01',
        }),
      ).toBe('NC_Vodafone_NC-99_2026-07-01.pdf');

      expect(
        generateStandardFileName({
          type: 'NOTA_DEBITO',
          supplier: 'MEO',
          docNumber: 'ND-12',
          docDate: '2026-06-10',
        }),
      ).toBe('ND_MEO_ND-12_2026-06-10.pdf');
    });
  });
});
