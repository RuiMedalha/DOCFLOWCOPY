import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FaturistaExtractionResponse {
  extracted?: Record<string, unknown>;
  confidence?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * FaturistaProvider — specialized Portuguese invoicing extraction service.
 * Configured via environment variables, disabled by default.
 */
@Injectable()
export class FaturistaProvider {
  private readonly logger = new Logger(FaturistaProvider.name);
  private readonly enabled: boolean;
  private readonly apiUrl: string | null;
  private readonly apiKey: string | null;

  constructor(config: ConfigService) {
    this.enabled = config.get<string>('FATURISTA_ENABLED') === 'true';
    this.apiUrl = config.get<string>('FATURISTA_API_URL') || null;
    this.apiKey = config.get<string>('FATURISTA_API_KEY') || null;
  }

  get isAvailable(): boolean {
    return this.enabled && Boolean(this.apiUrl);
  }

  async testConnection(): Promise<{ success: boolean; message: string; latencyMs: number }> {
    if (!this.isAvailable) {
      return {
        success: false,
        message: 'Faturista provider está desativado ou FATURISTA_API_URL não está configurada.',
        latencyMs: 0,
      };
    }

    const start = Date.now();
    try {
      const res = await fetch(`${this.apiUrl}/health`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { success: true, message: 'Ligação ao Faturista estabelecida com sucesso', latencyMs };
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
      const res = await fetch(`${this.apiUrl}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          fileBase64: request.fileBase64,
          mimeType: request.mimeType,
          text: request.text,
          fileName: request.fileName,
        }),
      });

      if (!res.ok) {
        this.logger.warn(`Faturista HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()) as FaturistaExtractionResponse;
      const duration = Date.now() - start;

      return {
        provider: 'faturista',
        model: 'faturista-pt-v1',
        confidence: data.confidence ?? 0.9,
        extracted: data.extracted ?? {},
        rawResponse: JSON.stringify(data),
        processingTimeMs: duration,
        fallbackUsed: false,
        tokensIn: data.tokensIn ?? 500,
        tokensOut: data.tokensOut ?? 300,
        estimatedCostEur: 0,
      };
    } catch (err) {
      this.logger.error(`Faturista error: ${(err as Error).message}`);
      return null;
    }
  }
}
