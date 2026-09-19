import { ConfigService } from '@nestjs/config';
import { ZeroxService, ZEROX_INVOICE_SCHEMA, ZEROX_SYSTEM_PROMPT, ZeroxOutput } from '../zerox.service';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('ZeroxService', () => {
  describe('Provider & Credentials Configuration', () => {
    it('detects available AI provider keys from ConfigService (OpenRouter and Fable 5.1)', () => {
      const cfgBoth = makeConfig({
        OPENROUTER_API_KEY: 'sk-or-test-123',
        gemini_API_KEY: 'gem-key-456',
      });
      const svcBoth = new ZeroxService(cfgBoth);
      expect(svcBoth.isAvailable()).toBe(true);

      const cfgOpenRouter = makeConfig({ OPENROUTER_API_KEY: 'sk-or-key' });
      const svcOpenRouter = new ZeroxService(cfgOpenRouter);
      expect(svcOpenRouter.isAvailable()).toBe(true);

      const cfggemini = makeConfig({ Google_API_KEY: 'Google-key' });
      const svcgemini = new ZeroxService(cfggemini);
      expect(svcgemini.isAvailable()).toBe(true);

      const cfgNone = makeConfig({});
      const svcNone = new ZeroxService(cfgNone);
      expect(svcNone.isAvailable()).toBe(false);
    });

    it('resolves default models and endpoints correctly', () => {
      const cfg = makeConfig({
        OPENROUTER_API_KEY: 'sk-or',
        OPENROUTER_MODEL: 'Google/gemini-2.5-flash',
        OPENROUTER_URL: 'https://openrouter.ai/api/v1/chat/completions',
        gemini_API_KEY: 'gem-123',
        gemini_MODEL: 'Fable 5.1',
      });
      const svc = new ZeroxService(cfg);
      expect(svc.isAvailable()).toBe(true);
    });
  });

  describe('Markdown Table Parsing (PaddleOCR & MinerU layout reference)', () => {
    it('parses standard Portuguese invoice Markdown tables into structured line items', () => {
      const svc = new ZeroxService(makeConfig({}));
      const markdown =
        '# Fatura FT 2024/991\n\n' +
        '| Ref | Descrição do Artigo | Qtd | Preço Unit | IVA % | Total Linha |\n' +
        '|:---|:---|:---:|:---:|:---:|:---|\n' +
        '| A01 | Consultoria de Software | 2 | 750,00 € | 23% | 1.500,00 € |\n' +
        '| B02 | Licença Cloud Anual | 1 | 250,50 € | 23% | 250,50 € |\n' +
        '| C03 | Formação Inicial | 5 | 50,00 € | 0% | 250,00 € |\n\n' +
        'Subtotal: 2.000,50 €\n' +
        'IVA: 402,62 €\n' +
        'Total: 2.403,12 €';

      const items = svc.parseMarkdownTables(markdown);
      expect(items).toBeDefined();
      expect(items!.length).toBe(3);

      expect(items![0]).toEqual({
        code: 'A01',
        description: 'Consultoria de Software',
        quantity: 2,
        unitPrice: 750,
        vatRate: 23,
        discount: undefined,
        lineTotal: 1500,
      });

      expect(items![1]).toEqual({
        code: 'B02',
        description: 'Licença Cloud Anual',
        quantity: 1,
        unitPrice: 250.5,
        vatRate: 23,
        discount: undefined,
        lineTotal: 250.5,
      });

      expect(items![2]).toEqual({
        code: 'C03',
        description: 'Formação Inicial',
        quantity: 5,
        unitPrice: 50,
        vatRate: 0,
        discount: undefined,
        lineTotal: 250,
      });
    });

    it('handles tables with discounts and European decimal separators', () => {
      const svc = new ZeroxService(makeConfig({}));
      const markdown =
        '| Artigo | Quant | Preço Un. | Desc. % | IVA | Total |\n' +
        '|---|---|---|---|---|---|\n' +
        '| Forno Convector Industrial | 1 | 3.200,00 | 10% | 23% | 2.880,00 |\n' +
        '| Tabuleiros Inox GN 1/1 | 10 | 18,50 | 0% | 23% | 185,00 |\n';

      const items = svc.parseMarkdownTables(markdown);
      expect(items!.length).toBe(2);
      expect(items![0].description).toBe('Forno Convector Industrial');
      expect(items![0].quantity).toBe(1);
      expect(items![0].unitPrice).toBe(3200);
      expect(items![0].discount).toBe(10);
      expect(items![0].vatRate).toBe(23);
      expect(items![0].lineTotal).toBe(2880);
    });
  });

  describe('Mapping ZeroxOutput to ExtractedFields', () => {
    it('maps complete Zerox output with structured JSON and Markdown to DocFlow ExtractedFields', () => {
      const svc = new ZeroxService(makeConfig({ OPENROUTER_API_KEY: 'key' }));

      const mockZeroxOutput: ZeroxOutput = {
        fileName: 'fatura-sample.pdf',
        completionTime: 1200,
        inputTokens: 850,
        outputTokens: 320,
        summary: {
          totalPages: 1,
          ocr: { successful: 1, failed: 0 },
          extracted: { successful: 1, failed: 0 },
        },
        extracted: {
          supplier: 'Sammic Equipamentos Hoteleiros Lda',
          supplierNif: '501234567',
          supplierAddress: 'Rua da Indústria, 42',
          supplierPostalCode: '2700-001',
          supplierCity: 'Amadora',
          customer: 'Hotel Atlântico S.A.',
          customerNif: '509876543',
          docNumber: 'FT 2026/0042',
          docDate: '2026-03-15',
          dueDate: '2026-04-15',
          currency: 'EUR',
          netAmount: 1000,
          taxAmount: 230,
          total: 1230,
          ivaBreakdown: [{ rate: 23, base: 1000, tax: 230 }],
          lineItems: [
            {
              code: 'SAM-101',
              description: 'Triturador Industrial TR-350',
              quantity: 1,
              unitPrice: 1000,
              vatRate: 23,
              lineTotal: 1000,
            },
          ],
        },
        pages: [
          {
            page: 1,
            content:
              '# FATURA FT 2026/0042\n' +
              'Fornecedor: Sammic Equipamentos Hoteleiros Lda\n' +
              'NIF: 501234567\n' +
              'Cliente: Hotel Atlântico S.A.\n' +
              'NIF Cliente: 509876543\n\n' +
              '| Ref | Descrição | Qtd | Preço | IVA | Total |\n' +
              '|---|---|---|---|---|---|\n' +
              '| SAM-101 | Triturador Industrial TR-350 | 1 | 1.000,00 € | 23% | 1.000,00 € |\n\n' +
              'Total: 1.230,00 €',
            status: 'SUCCESS' as any,
          },
        ],
      };

      const fields = svc.mapZeroxOutputToExtractedFields(
        mockZeroxOutput,
        mockZeroxOutput.pages[0].content!,
        'fatura-sample.pdf',
      );

      expect(fields.supplier).toBe('Sammic Equipamentos Hoteleiros Lda');
      expect(fields.supplierNif).toBe('501234567');
      expect(fields.customer).toBe('Hotel Atlântico S.A.');
      expect(fields.customerNif).toBe('509876543');
      expect(fields.docNumber).toBe('FT 2026/0042');
      expect(fields.docDate).toBe('2026-03-15');
      expect(fields.dueDate).toBe('2026-04-15');
      expect(fields.total).toBe(1230);
      expect(fields.netAmount).toBe(1000);
      expect(fields.taxAmount).toBe(230);
      expect(fields.currency).toBe('EUR');
      expect(fields.totalsReconciled).toBe(true);
      expect(fields.lineItems).toHaveLength(1);
      expect(fields.lineItems![0].description).toBe('Triturador Industrial TR-350');
      expect(fields.lineItems![0].lineTotal).toBe(1000);
      expect(fields.ivaBreakdown).toEqual([{ rate: 23, base: 1000, tax: 230 }]);
      expect(fields.confidence).toBeGreaterThanOrEqual(0.85);
      expect(fields.source).toBe('ai');
    });

    it('recovers fields from Markdown text when structured JSON has missing fields', () => {
      const svc = new ZeroxService(makeConfig({ OPENROUTER_API_KEY: 'key' }));

      const mockZeroxOutput: ZeroxOutput = {
        fileName: 'recibo.pdf',
        completionTime: 900,
        inputTokens: 500,
        outputTokens: 200,
        summary: {
          totalPages: 1,
          ocr: { successful: 1, failed: 0 },
          extracted: { successful: 1, failed: 0 },
        },
        extracted: null,
        pages: [
          {
            page: 1,
            content:
              'Fornecedor: Américo Alves & Filhos Lda\n' +
              'NIF: PT502998877\n' +
              'Fatura: FT 2025/8812\n' +
              'Data: 2025-11-20\n' +
              'Vencimento: 2025-12-20\n\n' +
              '| Artigo | Quantidade | Preço | IVA | Total |\n' +
              '|---|---|---|---|---|---|\n' +
              '| Caixa Copos Vidro 25cl | 4 | 25,00 | 23% | 100,00 |\n\n' +
              'Subtotal: 100,00\n' +
              'IVA: 23,00\n' +
              'Total: 123,00',
            status: 'SUCCESS' as any,
          },
        ],
      };

      const fields = svc.mapZeroxOutputToExtractedFields(
        mockZeroxOutput,
        mockZeroxOutput.pages[0].content!,
        'recibo.pdf',
      );

      expect(fields.supplier).toContain('Américo Alves');
      expect(fields.supplierNif).toBe('502998877');
      expect(fields.docNumber).toBe('FT 2025/8812');
      expect(fields.docDate).toBe('2025-11-20');
      expect(fields.dueDate).toBe('2025-12-20');
      expect(fields.total).toBe(123);
      expect(fields.netAmount).toBe(100);
      expect(fields.taxAmount).toBe(23);
      expect(fields.lineItems).toHaveLength(1);
      expect(fields.lineItems![0].description).toBe('Caixa Copos Vidro 25cl');
      expect(fields.totalsReconciled).toBe(true);
    });
  });

  describe('VisionExtractedFields Conversion', () => {
    it('maps ExtractedFields to VisionExtractedFields preserving line items and tax breakdown', () => {
      const svc = new ZeroxService(makeConfig({}));
      const ext = {
        supplier: 'Empresa Teste',
        supplierNif: '500100200',
        docNumber: 'FT 1',
        docDate: '2026-01-01',
        total: 100,
        netAmount: 80,
        taxAmount: 20,
        currency: 'EUR',
        confidence: 0.9,
        source: 'ai' as const,
        hints: [],
        warnings: [],
        lineItems: [{ description: 'Artigo 1', quantity: 1, unitPrice: 80, lineTotal: 80 }],
        ivaBreakdown: [{ rate: 23, base: 80, tax: 18.4 }],
      };

      const vision = svc.mapToVisionExtractedFields(ext);
      expect(vision.supplier).toBe('Empresa Teste');
      expect(vision.supplierNif).toBe('500100200');
      expect(vision.lineItems).toHaveLength(1);
      expect(vision.lineItems![0].description).toBe('Artigo 1');
      expect(vision.ivaBreakdown).toHaveLength(1);
    });
  });

  describe('Process Document with Zerox & Mock Execution', () => {
    it('handles processDocument with mocked zerox execution and returns structured result', async () => {
      const svc = new ZeroxService(makeConfig({ OPENROUTER_API_KEY: 'sk-mock' }));

      const mockZeroxOutput: ZeroxOutput = {
        fileName: 'invoice.pdf',
        completionTime: 1500,
        inputTokens: 1000,
        outputTokens: 400,
        summary: {
          totalPages: 1,
          ocr: { successful: 1, failed: 0 },
          extracted: { successful: 1, failed: 0 },
        },
        extracted: {
          supplier: 'Makro Portugal',
          supplierNif: '500200300',
          total: 500,
          netAmount: 406.5,
          taxAmount: 93.5,
          currency: 'EUR',
          docNumber: 'FT 2026/999',
        },
        pages: [
          {
            page: 1,
            content: '# Fatura Makro\nTotal: 500,00 €',
            status: 'SUCCESS' as any,
          },
        ],
      };

      jest.spyOn(svc as any, 'executeZerox').mockResolvedValue(mockZeroxOutput);

      const sampleBuffer = Buffer.from('mock pdf content');
      const result = await svc.processDocument({
        buffer: sampleBuffer,
        mimeType: 'application/pdf',
        fileName: 'invoice.pdf',
      });

      expect(result.success).toBe(true);
      expect(result.extracted.supplier).toBe('Makro Portugal');
      expect(result.extracted.supplierNif).toBe('500200300');
      expect(result.extracted.total).toBe(500);
      expect(result.markdown).toContain('# Fatura Makro');
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(400);
    });

    it('handles error gracefully when execution fails and returns safe empty structure', async () => {
      const svc = new ZeroxService(makeConfig({ OPENROUTER_API_KEY: 'sk-mock' }));
      jest.spyOn(svc as any, 'executeZerox').mockRejectedValue(new Error('Zerox model timeout'));

      const result = await svc.processDocument({
        buffer: Buffer.from('test'),
        mimeType: 'image/png',
        fileName: 'error.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Zerox model timeout');
      expect(result.extracted.confidence).toBe(0);
      expect(result.extracted.currency).toBe('EUR');
    });
  });
});
