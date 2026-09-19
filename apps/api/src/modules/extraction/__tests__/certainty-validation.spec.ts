import {
  validateTriangulation,
  validateVatRates,
  validateLineItemsTable,
  calculateCertaintyScore,
  LEGAL_ROUNDING_TOLERANCE,
  PT_CONTINENTAL_VAT_RATES,
  ALL_OFFICIAL_PT_VAT_RATES,
} from '../field-validation';

describe('Field Validation & Certainty Engine (95% - 99%)', () => {
  describe('validateTriangulation() — Triangulação estrita Líquido + IVA == Total', () => {
    it('aprova triangulação perfeita com delta 0.00€', () => {
      const res = validateTriangulation({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
      });
      expect(res.isValid).toBe(true);
      expect(res.delta).toBe(0);
      expect(res.reason).toBe('triangulacao_perfeita');
      expect(res.passedCheck).toContain('Triangulação estrita válida');
    });

    it('aprova triangulação com tolerância legal de arredondamento de até 0.02€', () => {
      const res1 = validateTriangulation({ netAmount: 100.0, taxAmount: 23.0, total: 123.02 });
      expect(res1.isValid).toBe(true);
      expect(res1.delta).toBe(-0.02);

      const res2 = validateTriangulation({ netAmount: 100.0, taxAmount: 23.0, total: 122.98 });
      expect(res2.isValid).toBe(true);
      expect(res2.delta).toBe(0.02);
    });

    it('rejeita triangulação quando a discrepância é superior a 0.02€', () => {
      const res = validateTriangulation({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 125.5,
      });
      expect(res.isValid).toBe(false);
      expect(res.delta).toBe(-2.5);
      expect(res.reason).toContain('triangulacao_falhou');
      expect(res.warning).toContain('Discrepância na triangulação');
      expect(res.warning).toContain('2.50€');
    });

    it('trata valores incompletos ou nulos sem rebentar', () => {
      const res = validateTriangulation({
        netAmount: 100.0,
        taxAmount: null,
        total: 123.0,
      });
      expect(res.isValid).toBe(false);
      expect(res.reason).toContain('valores_incompletos');
      expect(res.warning).toContain('faltam: IVA');
    });
  });

  describe('validateVatRates() — Taxas oficiais de Portugal (CIVA) e Comunitárias', () => {
    it('aprova taxas oficiais de Portugal Continental (23%, 13%, 6%, 0%)', () => {
      const res = validateVatRates({
        rates: [23, 13, 6, 0],
        country: 'PT',
      });
      expect(res.isValid).toBe(true);
      expect(res.invalidRates).toHaveLength(0);
      expect(res.validRates).toEqual([23, 13, 6, 0]);
      expect(res.passedChecks[0]).toContain('Portugal (CIVA)');
    });

    it('aprova taxas das regiões autónomas (Madeira 22%, 12%, 5% e Açores 16%, 9%, 4%)', () => {
      const res = validateVatRates({
        rates: [22, 16, 5],
        country: 'PT',
      });
      expect(res.isValid).toBe(true);
      expect(res.validRates).toEqual([22, 16, 5]);
    });

    it('rejeita taxas inventadas ou incorretas em Portugal (ex: 21%, 19%)', () => {
      const res = validateVatRates({
        rates: [23, 21],
        country: 'PT',
      });
      expect(res.isValid).toBe(false);
      expect(res.invalidRates).toEqual([21]);
      expect(res.warnings[0]).toContain('Taxa de IVA 21% não é uma taxa oficial em Portugal');
    });

    it('aprova taxa 0% em aquisições intracomunitárias com autoliquidação (reverse charge)', () => {
      const res = validateVatRates({
        rates: [0],
        country: 'ES',
        isIntracommunity: true,
      });
      expect(res.isValid).toBe(true);
      expect(res.validRates).toEqual([0]);
    });
  });

  describe('validateLineItemsTable() — Integridade da tabela de artigos', () => {
    it('valida linha com Qtd × Preço Unitário == Subtotal', () => {
      const items = [
        { description: 'Artigo 1', quantity: 2, unitPrice: 25.0, lineTotal: 50.0 },
        { description: 'Artigo 2', quantity: 1, unitPrice: 50.0, lineTotal: 50.0 },
      ];
      const res = validateLineItemsTable(items, { netAmount: 100.0, total: 123.0 });
      expect(res.isValid).toBe(true);
      expect(res.sumOfLines).toBe(100.0);
      expect(res.lineDiscrepancies).toHaveLength(0);
    });

    it('valida linha com desconto de linha (Qtd × Preço - Desconto == Subtotal)', () => {
      const items = [
        { description: 'Artigo Desconto', quantity: 2, unitPrice: 50.0, discount: 10.0, lineTotal: 90.0 },
      ];
      const res = validateLineItemsTable(items, { netAmount: 90.0 });
      expect(res.isValid).toBe(true);
      expect(res.sumOfLines).toBe(90.0);
    });

    it('detecta discrepância na soma das linhas face ao total', () => {
      const items = [
        { description: 'Artigo 1', quantity: 1, unitPrice: 40.0, lineTotal: 40.0 },
        { description: 'Artigo 2', quantity: 1, unitPrice: 50.0, lineTotal: 50.0 },
      ];
      // Soma é 90.00€ mas cabeçalho diz 100.00€
      const res = validateLineItemsTable(items, { netAmount: 100.0 });
      expect(res.isValid).toBe(false);
      expect(res.tableDelta).toBe(-10.0);
      expect(res.warnings[0]).toContain('Soma das linhas difere do total em 10.00€');
    });
  });

  describe('calculateCertaintyScore() — Motor de pontuação de certeza (95% a 99%)', () => {
    it('atribui 99.9% (OFFICIAL_AT) quando existe QR-AT oficial assinado pela AT', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000208', // PT válido
        atcud: 'J6Z8J3VX-2285',
        hash4: 'J6Z8',
        softwareCert: '2285',
        qrOrigin: 'qr',
      });
      expect(scoreRes.score).toBe(99.9);
      expect(scoreRes.level).toBe('OFFICIAL_AT');
      expect(scoreRes.needsReview).toBe(false);
      expect(scoreRes.passedChecks).toContain(
        'QR-AT oficial validado pela AT com assinatura válida (ATCUD + Certificado AT + Hash4)',
      );
    });

    it('atribui 98% (PERFECT_TRIANGULATION) quando há triangulação perfeita + NIF PT mod-11 sem QR oficial', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000208', // NIF PT com módulo 11 válido
        country: 'PT',
        taxRate: 23,
        lineItems: [
          { description: 'Item 1', quantity: 2, unitPrice: 50.0, lineTotal: 100.0 },
        ],
      });
      expect(scoreRes.score).toBe(98.0);
      expect(scoreRes.level).toBe('PERFECT_TRIANGULATION');
      expect(scoreRes.needsReview).toBe(false);
      expect(scoreRes.triangulation.isValid).toBe(true);
      expect(scoreRes.taxIdResolution.validation).toBe('PT_MOD11');
    });

    it('penaliza para <95% e marca needsReview quando a triangulação falha', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 130.0, // Erro de 7€!
        supplierNif: '501000208',
        country: 'PT',
      });
      expect(scoreRes.score).toBeLessThan(95.0);
      expect(scoreRes.needsReview).toBe(true);
      expect(scoreRes.warnings.some((w) => w.includes('Discrepância na triangulação'))).toBe(true);
    });

    it('penaliza para <95% e marca needsReview quando a soma das linhas de artigos diverge', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000206',
        country: 'PT',
        lineItems: [
          { description: 'Item A', quantity: 1, unitPrice: 97.5, lineTotal: 97.5 }, // Falta 2.50€
        ],
      });
      expect(scoreRes.score).toBeLessThan(95.0);
      expect(scoreRes.needsReview).toBe(true);
      expect(scoreRes.warnings.some((w) => w.includes('Soma das linhas difere do total em 2.50€'))).toBe(true);
    });

    it('aprova 99.9% (OFFICIAL_AT) quando o NIF da empresa adquirente está confirmado', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000208',
        atcud: 'J6Z8J3VX-2285',
        hash4: 'J6Z8',
        softwareCert: '2285',
        qrOrigin: 'qr',
        tenantNif: '502084006',
        customerNif: '502084006',
      });
      expect(scoreRes.score).toBe(99.9);
      expect(scoreRes.level).toBe('OFFICIAL_AT');
      expect(scoreRes.tenantNifValidation?.status).toBe('CONFIRMED');
      expect(scoreRes.tenantNifValidation?.isOfficialDocument).toBe(true);
      expect(scoreRes.needsReview).toBe(false);
    });

    it('salvaguarda fiscal: impede OFFICIAL_AT e limita a 70% quando documento não tem NIF da empresa (art. 36.º CIVA)', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000208',
        atcud: 'J6Z8J3VX-2285',
        hash4: 'J6Z8',
        softwareCert: '2285',
        qrOrigin: 'qr',
        tenantNif: '502084006',
        customerNif: '999999990', // Consumidor Final
      });
      expect(scoreRes.score).toBeLessThanOrEqual(70.0);
      expect(scoreRes.level).toBe('REVIEW_REQUIRED');
      expect(scoreRes.needsReview).toBe(true);
      expect(scoreRes.tenantNifValidation?.status).toBe('MISSING_NIF');
      expect(scoreRes.tenantNifValidation?.isOfficialDocument).toBe(false);
      expect(scoreRes.warnings.some((w) => w.includes('art. 36.º do CIVA'))).toBe(true);
    });

    it('salvaguarda fiscal: emite alerta crítico e limita a 45% quando NIF de adquirente é de terceiro', () => {
      const scoreRes = calculateCertaintyScore({
        netAmount: 100.0,
        taxAmount: 23.0,
        total: 123.0,
        supplierNif: '501000208',
        atcud: 'J6Z8J3VX-2285',
        hash4: 'J6Z8',
        softwareCert: '2285',
        qrOrigin: 'qr',
        tenantNif: '502084006',
        customerNif: '509999999', // Outra empresa qualquer
      });
      expect(scoreRes.score).toBeLessThanOrEqual(45.0);
      expect(scoreRes.level).toBe('CRITICAL');
      expect(scoreRes.needsReview).toBe(true);
      expect(scoreRes.tenantNifValidation?.status).toBe('MISMATCH_THIRD_PARTY');
      expect(scoreRes.tenantNifValidation?.isOfficialDocument).toBe(false);
      expect(scoreRes.warnings.some((w) => w.includes('ALERTA FISCAL CRÍTICO'))).toBe(true);
    });
  });
});
