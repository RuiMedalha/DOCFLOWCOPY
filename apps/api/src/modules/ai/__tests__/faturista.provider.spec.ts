import { ConfigService } from '@nestjs/config';
import { FaturistaProvider } from '../providers/faturista.provider';

describe('FaturistaProvider', () => {
  it('is available when FATURISTA_URL is configured and not empty', () => {
    const config = {
      get: jest.fn((k) => {
        if (k === 'FATURISTA_URL') return 'https://faturista.profihotel.pt';
        return null;
      }),
    } as unknown as ConfigService;

    const provider = new FaturistaProvider(config);
    expect(provider.isAvailable).toBe(true);
  });

  it('is NOT available when FATURISTA_URL is omitted or disabled', () => {
    const config = {
      get: jest.fn(() => null),
    } as unknown as ConfigService;

    const provider = new FaturistaProvider(config);
    expect(provider.isAvailable).toBe(false);
  });

  it('correctly maps Faturista JSON output to DocFlow VisionExtractedFields', async () => {
    const config = {
      get: jest.fn((k) => {
        if (k === 'FATURISTA_URL') return 'https://faturista.profihotel.pt';
        return null;
      }),
    } as unknown as ConfigService;

    const provider = new FaturistaProvider(config);

    const sampleFaturistaOutput = {
      tipo_documento: 'fatura',
      numero_documento: 'FT 2026/99',
      atcud: 'CSDF98-1234',
      datas: {
        data_emissao: '2026-09-15',
        data_vencimento: '2026-10-15',
      },
      vendedor: {
        nome: 'EDP Comercial, SA',
        nif: '503504564',
        morada: {
          rua: 'Av. 24 de Julho 12',
          codigo_postal: '1200-480',
          cidade: 'Lisboa',
        },
      },
      cliente: {
        nome: 'NOV OUSADO UNIPESSOAL LDA',
        nif: '515208566',
      },
      linhas: [
        {
          descricao: 'Eletricidade MT',
          quantidade: '1',
          preco_unitario: '100.00',
          taxa_iva: '23',
          total_linha: '100.00',
        },
      ],
      totais: {
        subtotal: '100.00',
        total_iva: '23.00',
        total: '123.00',
        iva_detalhe: [
          {
            taxa: '23',
            base_incidencia: '100.00',
            valor_iva: '23.00',
          },
        ],
      },
    };

    // Simular fetch com resposta válida
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify(sampleFaturistaOutput),
            },
          },
        ],
        usage: {
          prompt_tokens: 450,
          completion_tokens: 180,
        },
      }),
    }) as any;

    const res = await provider.extract({
      fileBase64: 'mock-base64-data',
      mimeType: 'image/jpeg',
    });

    expect(res).toBeDefined();
    expect(res.provider).toBe('faturista');
    expect(res.confidence).toBeGreaterThanOrEqual(0.8);
    expect(res.extracted.supplier).toBe('EDP Comercial, SA');
    expect(res.extracted.supplierNif).toBe('503504564');
    expect(res.extracted.total).toBe(123.0);
    expect(res.extracted.netAmount).toBe(100.0);
    expect(res.extracted.taxAmount).toBe(23.0);
    expect(res.extracted.docNumber).toBe('FT 2026/99');
    expect(res.extracted.atcud).toBe('CSDF98-1234');
    expect(res.extracted.lineItems).toHaveLength(1);
    expect(res.extracted.lineItems[0].description).toBe('Eletricidade MT');
    expect(res.extracted.ivaBreakdown).toHaveLength(1);
    expect(res.extracted.ivaBreakdown[0].rate).toBe(23);
  });
});
