import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VisionExtractedFields } from '../vision.service';

export interface FaturistaRawOutput {
  tipo_documento?: string | null;
  numero_documento?: string | null;
  numero_fatura?: string | null;
  atcud?: string | null;
  metodo_pagamento?: string | null;
  matricula?: string | null;
  datas?: {
    data_emissao?: string | null;
    data_vencimento?: string | null;
    data_transacao?: string | null;
  };
  vendedor?: {
    nome?: string | null;
    nif?: string | null;
    morada?: {
      rua?: string | null;
      codigo_postal?: string | null;
      cidade?: string | null;
      pais?: string | null;
    };
    contacto?: {
      telefone?: string | null;
      email?: string | null;
    };
  };
  cliente?: {
    nome?: string | null;
    nif?: string | null;
  };
  linhas?: Array<{
    codigo?: string | null;
    descricao?: string | null;
    quantidade?: string | number | null;
    unidade?: string | null;
    preco_unitario?: string | number | null;
    desconto_percentagem?: string | number | null;
    taxa_iva?: string | number | null;
    total_linha?: string | number | null;
  }>;
  totais?: {
    subtotal?: string | number | null;
    total_descontos?: string | number | null;
    total_iva?: string | number | null;
    total?: string | number | null;
    iva_detalhe?: Array<{
      taxa?: string | number | null;
      base_incidencia?: string | number | null;
      valor_iva?: string | number | null;
    }>;
  };
}

/**
 * FaturistaProvider — specialized Portuguese invoicing extraction service
 * running on llama.cpp server (Qwen3-VL-4B fine-tuned for PT fiscal documents).
 */
@Injectable()
export class FaturistaProvider {
  private readonly logger = new Logger(FaturistaProvider.name);
  private readonly enabled: boolean;
  private readonly apiUrl: string | null;
  private readonly apiKey: string | null;

  constructor(config: ConfigService) {
    let url = config.get<string>('FATURISTA_URL') || config.get<string>('FATURISTA_API_URL') || null;
    if (url) {
      url = url.trim().replace(/\/+$/, '');
    }
    this.apiUrl = url;
    const explicitlyDisabled = config.get<string>('FATURISTA_ENABLED') === 'false';
    this.enabled = Boolean(this.apiUrl && this.apiUrl.length > 0) && !explicitlyDisabled;
    this.apiKey = config.get<string>('FATURISTA_API_KEY') || null;
  }

  get isAvailable(): boolean {
    return this.enabled && Boolean(this.apiUrl && this.apiUrl.length > 0);
  }

  private get endpointUrl(): string {
    if (!this.apiUrl) return '';
    if (this.apiUrl.endsWith('/v1')) {
      return `${this.apiUrl}/chat/completions`;
    }
    return `${this.apiUrl}/v1/chat/completions`;
  }

  private get healthUrl(): string {
    if (!this.apiUrl) return '';
    const base = this.apiUrl.replace(/\/v1$/, '');
    return `${base}/health`;
  }

  async testConnection(): Promise<{ success: boolean; message: string; latencyMs: number }> {
    if (!this.isAvailable) {
      return {
        success: false,
        message: 'Faturista provider está desativado ou FATURISTA_URL não está configurada.',
        latencyMs: 0,
      };
    }

    const start = Date.now();
    try {
      const res = await fetch(this.healthUrl, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return {
          success: true,
          message: 'Ligação ao servidor Faturista estabelecida com sucesso (HTTP 200 ok)',
          latencyMs,
        };
      }
      return { success: false, message: `Faturista respondeu com HTTP ${res.status}`, latencyMs };
    } catch (err) {
      return { success: false, message: (err as Error).message, latencyMs: Date.now() - start };
    }
  }

  async extract(request: {
    fileBase64?: string;
    mimeType?: string;
    text?: string;
    fileName?: string;
  }): Promise<any | null> {
    if (!this.isAvailable) return null;
    const start = Date.now();

    try {
      const promptText = 'Extrai os dados estruturados desta fatura ou documento fiscal português em formato JSON.';
      const contentParts: any[] = [{ type: 'text', text: promptText }];

      if (request.fileBase64) {
        const mime = request.mimeType || 'image/jpeg';
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${mime};base64,${request.fileBase64}`,
          },
        });
      } else if (request.text) {
        contentParts.push({
          type: 'text',
          text: `Texto do documento:\n${request.text}`,
        });
      }

      const payload = {
        messages: [
          {
            role: 'user',
            content: contentParts,
          },
        ],
        temperature: 0.0,
        max_tokens: 2048,
      };

      const res = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        this.logger.warn(`Faturista HTTP ${res.status}: ${errText}`);
        return null;
      }

      const resJson = await res.json() as any;
      const rawContent = resJson?.choices?.[0]?.message?.content ?? '';
      const duration = Date.now() - start;

      let parsed: FaturistaRawOutput;
      try {
        parsed = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
      } catch (e) {
        this.logger.warn(`[FaturistaProvider] Falha ao fazer parse de JSON: ${(e as Error).message}`);
        return null;
      }

      const extracted = this.mapFaturistaToDocFlow(parsed);
      const confidence = this.computeConfidence(extracted);

      this.logger.log(
        `[FaturistaProvider] Extração concluída em ${duration}ms (confiança=${confidence.toFixed(2)}, total=${extracted.total}, fornecedor="${extracted.supplier}")`,
      );

      return {
        provider: 'faturista',
        model: 'destilar-ia/faturista-4b',
        confidence,
        extracted,
        rawResponse: rawContent,
        processingTimeMs: duration,
        fallbackUsed: false,
        tokensIn: resJson?.usage?.prompt_tokens ?? 500,
        tokensOut: resJson?.usage?.completion_tokens ?? 300,
        estimatedCostEur: 0.0,
      };
    } catch (err) {
      this.logger.error(`Faturista request failed: ${(err as Error).message}`);
      return null;
    }
  }

  private parseNum(val: any): number | null {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return isFinite(val) ? val : null;
    const clean = String(val).replace(/\s/g, '').replace(/€/g, '').replace(/,/g, '.');
    const n = parseFloat(clean);
    return isNaN(n) ? null : n;
  }

  private mapFaturistaToDocFlow(raw: FaturistaRawOutput): VisionExtractedFields {
    const total = this.parseNum(raw.totais?.total) ?? undefined;
    const netAmount = this.parseNum(raw.totais?.subtotal) ?? undefined;
    const taxAmount = this.parseNum(raw.totais?.total_iva) ?? undefined;
    const discountAmount = this.parseNum(raw.totais?.total_descontos) ?? undefined;

    const lineItems = (raw.linhas ?? []).map((l) => ({
      code: l.codigo || undefined,
      description: l.descricao || 'Item sem descrição',
      quantity: this.parseNum(l.quantidade) ?? 1,
      unitPrice: this.parseNum(l.preco_unitario) ?? undefined,
      vatRate: this.parseNum(l.taxa_iva) ?? undefined,
      discount: this.parseNum(l.desconto_percentagem) ?? undefined,
      lineTotal: this.parseNum(l.total_linha) ?? undefined,
    }));

    const ivaBreakdown = (raw.totais?.iva_detalhe ?? []).map((i) => ({
      rate: this.parseNum(i.taxa) ?? 0,
      base: this.parseNum(i.base_incidencia) ?? 0,
      tax: this.parseNum(i.valor_iva) ?? 0,
    }));

    let docType = 'FATURA';
    if (raw.tipo_documento === 'nota_credito') docType = 'NOTA_CREDITO';
    if (raw.tipo_documento === 'nota_debito') docType = 'NOTA_DEBITO';
    if (raw.tipo_documento === 'fatura_recibo' || raw.tipo_documento === 'fatura_simplificada') {
      docType = 'FATURA_SIMPLIFICADA';
    }
    if (raw.tipo_documento === 'recibo') docType = 'RECIBO';

    return {
      supplier: raw.vendedor?.nome || undefined,
      supplierNif: raw.vendedor?.nif || undefined,
      supplierAddress: raw.vendedor?.morada?.rua || undefined,
      supplierPostalCode: raw.vendedor?.morada?.codigo_postal || undefined,
      supplierCity: raw.vendedor?.morada?.cidade || undefined,
      supplierPhone: raw.vendedor?.contacto?.telefone || undefined,
      supplierEmail: raw.vendedor?.contacto?.email || undefined,
      customer: raw.cliente?.nome || undefined,
      customerNif: raw.cliente?.nif || undefined,
      docNumber: raw.numero_fatura || raw.numero_documento || undefined,
      atcud: raw.atcud || undefined,
      docDate: raw.datas?.data_emissao || undefined,
      dueDate: raw.datas?.data_vencimento || undefined,
      total,
      netAmount,
      taxAmount,
      discountAmount,
      currency: 'EUR',
      country: 'PT',
      documentType: docType,
      lineItems: lineItems.length > 0 ? lineItems : undefined,
      ivaBreakdown: ivaBreakdown.length > 0 ? ivaBreakdown : undefined,
      isEuIntracommunity: false,
    };
  }

  private computeConfidence(extracted: VisionExtractedFields): number {
    let score = 0;
    if (extracted.total !== null && extracted.total !== undefined) score += 0.3;
    if (extracted.supplier) score += 0.25;
    if (extracted.supplierNif) score += 0.2;
    if (extracted.docNumber) score += 0.15;
    if (extracted.docDate) score += 0.1;
    return Math.min(0.99, Number(score.toFixed(2)));
  }
}
