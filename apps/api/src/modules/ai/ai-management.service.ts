import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FaturistaProvider } from './providers/faturista.provider';

export interface ModelPricing {
  inputPerM: number; // EUR per 1M tokens
  outputPerM: number; // EUR per 1M tokens
}

export interface AiModelInfo {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'minimax' | 'faturista';
  contextWindow: number;
  supportsVision: boolean;
  pricing: ModelPricing;
  isRecommended?: boolean;
}

export interface AiTaskRouting {
  triage: string;
  extraction: string;
  enrichment: string;
}

export interface AiSettingsDto {
  defaultProvider: string;
  taskRouting: AiTaskRouting;
  providers: {
    anthropic: { configured: boolean; model: string };
    openai: { configured: boolean; model: string };
    gemini: { configured: boolean; model: string };
    openrouter: { configured: boolean; model: string };
    minimax: { configured: boolean; model: string };
    faturista: { configured: boolean; model: string };
  };
}

export interface AiMetricsDto {
  totalExtractions: number;
  totalEstimatedCostEur: number;
  avgProcessingTimeMs: number;
  avgConfidence: number;
  fallbackCount: number;
  fallbackRate: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  recentExtractions: Array<{
    documentId: string;
    fileName: string;
    provider: string;
    model: string;
    processingTimeMs: number;
    estimatedCostEur: number;
    confidence: number;
    fallbackUsed: boolean;
    timestamp: string;
  }>;
}

// Built-in models catalog with estimated EUR pricing per 1M tokens
export const BUILTIN_MODELS: AiModelInfo[] = [
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 1000000,
    supportsVision: true,
    pricing: { inputPerM: 0.15, outputPerM: 0.6 },
    isRecommended: true,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 200000,
    supportsVision: true,
    pricing: { inputPerM: 2.8, outputPerM: 14.0 },
    isRecommended: true,
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 128000,
    supportsVision: true,
    pricing: { inputPerM: 2.3, outputPerM: 9.2 },
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 128000,
    supportsVision: true,
    pricing: { inputPerM: 0.14, outputPerM: 0.56 },
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3 (via OpenRouter)',
    provider: 'openrouter',
    contextWindow: 64000,
    supportsVision: false,
    pricing: { inputPerM: 0.14, outputPerM: 0.28 },
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet v2 (Directo)',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    pricing: { inputPerM: 2.8, outputPerM: 14.0 },
    isRecommended: true,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku (Directo)',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    pricing: { inputPerM: 0.75, outputPerM: 3.75 },
  },
  {
    id: 'claude-3-7-sonnet-latest',
    name: 'Claude 3.7 Sonnet (Directo)',
    provider: 'anthropic',
    contextWindow: 200000,
    supportsVision: true,
    pricing: { inputPerM: 2.8, outputPerM: 14.0 },
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o (Directo)',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    pricing: { inputPerM: 2.3, outputPerM: 9.2 },
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini (Directo)',
    provider: 'openai',
    contextWindow: 128000,
    supportsVision: true,
    pricing: { inputPerM: 0.14, outputPerM: 0.56 },
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Directo Google)',
    provider: 'gemini',
    contextWindow: 1000000,
    supportsVision: true,
    pricing: { inputPerM: 0.15, outputPerM: 0.6 },
    isRecommended: true,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (Directo Google)',
    provider: 'gemini',
    contextWindow: 2000000,
    supportsVision: true,
    pricing: { inputPerM: 1.2, outputPerM: 4.8 },
  },
  {
    id: 'minimax/MiniMax-VL-01',
    name: 'MiniMax VL 01 (Vision)',
    provider: 'minimax',
    contextWindow: 128000,
    supportsVision: true,
    pricing: { inputPerM: 0.2, outputPerM: 1.1 },
  },
  {
    id: 'faturista-pt-v1',
    name: 'Faturista PT v1 (Motor Local/Dedicado)',
    provider: 'faturista',
    contextWindow: 32000,
    supportsVision: true,
    pricing: { inputPerM: 0.0, outputPerM: 0.0 },
  },
];

@Injectable()
export class AiManagementService {
  private readonly logger = new Logger(AiManagementService.name);
  private cachedOpenRouterModels: AiModelInfo[] = [];
  private lastModelsRefresh = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly faturista: FaturistaProvider,
  ) {}

  /**
   * Obtém as definições de IA do tenant com fallback para variáveis de ambiente.
   */
  async getSettings(tenantId: string): Promise<AiSettingsDto> {
    const integration = await this.prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId, provider: 'ai_settings' } },
    });

    const configData = (integration?.config as Record<string, any>) || {};

    const hasAnthropic = Boolean(this.config.get<string>('ANTHROPIC_API_KEY'));
    const hasOpenai = Boolean(this.config.get<string>('OPENAI_API_KEY'));
    const hasGemini = Boolean(
      this.config.get<string>('GEMINI_API_KEY') || this.config.get<string>('GOOGLE_API_KEY'),
    );
    const hasOpenrouter = Boolean(this.config.get<string>('OPENROUTER_API_KEY'));
    const hasMinimax = Boolean(this.config.get<string>('MINIMAX_API_KEY'));
    const hasFaturista = this.faturista.isAvailable;

    const defaultProvider =
      configData.defaultProvider ||
      (hasOpenrouter
        ? 'openrouter'
        : hasGemini
          ? 'gemini'
          : hasAnthropic
            ? 'anthropic'
            : hasOpenai
              ? 'openai'
              : 'local-fallback');

    const taskRouting: AiTaskRouting = {
      triage: configData.taskRouting?.triage || 'google/gemini-2.5-flash',
      extraction: configData.taskRouting?.extraction || 'google/gemini-2.5-flash',
      enrichment: configData.taskRouting?.enrichment || 'google/gemini-2.5-flash',
    };

    return {
      defaultProvider,
      taskRouting,
      providers: {
        anthropic: {
          configured: hasAnthropic,
          model: this.config.get<string>('ANTHROPIC_MODEL') || 'claude-3-5-sonnet-20241022',
        },
        openai: {
          configured: hasOpenai,
          model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o',
        },
        gemini: {
          configured: hasGemini,
          model: this.config.get<string>('GEMINI_MODEL') || 'gemini-2.5-flash',
        },
        openrouter: {
          configured: hasOpenrouter,
          model: this.config.get<string>('OPENROUTER_MODEL') || 'google/gemini-2.5-flash',
        },
        minimax: {
          configured: hasMinimax,
          model: this.config.get<string>('MINIMAX_MODEL') || 'minimax/MiniMax-VL-01',
        },
        faturista: {
          configured: hasFaturista,
          model: 'faturista-pt-v1',
        },
      },
    };
  }

  /**
   * Guarda as definições de IA do tenant.
   */
  async updateSettings(
    tenantId: string,
    settings: {
      defaultProvider?: string;
      taskRouting?: Partial<AiTaskRouting>;
    },
  ): Promise<AiSettingsDto> {
    const current = await this.getSettings(tenantId);
    const updatedConfig = {
      defaultProvider: settings.defaultProvider || current.defaultProvider,
      taskRouting: {
        ...current.taskRouting,
        ...(settings.taskRouting || {}),
      },
    };

    await this.prisma.integration.upsert({
      where: { tenantId_provider: { tenantId, provider: 'ai_settings' } },
      create: {
        tenantId,
        provider: 'ai_settings',
        credentials: {},
        config: updatedConfig,
        isActive: true,
      },
      update: {
        config: updatedConfig,
      },
    });

    return this.getSettings(tenantId);
  }

  /**
   * Atualiza a lista de modelos da OpenRouter consultando a API pública.
   */
  async refreshOpenRouterModels(): Promise<AiModelInfo[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{
            id: string;
            name?: string;
            context_length?: number;
            architecture?: { modality?: string };
            pricing?: { prompt?: string; completion?: string };
          }>;
        };

        const rawList = data.data ?? [];
        const mapped: AiModelInfo[] = rawList
          .slice(0, 100)
          .map((m) => {
            const promptPricePerToken = parseFloat(m.pricing?.prompt || '0');
            const compPricePerToken = parseFloat(m.pricing?.completion || '0');
            const supportsVision =
              m.architecture?.modality?.includes('image') ||
              m.id.includes('flash') ||
              m.id.includes('vision') ||
              m.id.includes('4o') ||
              m.id.includes('sonnet');

            return {
              id: m.id,
              name: `${m.name || m.id} (OpenRouter)`,
              provider: 'openrouter' as const,
              contextWindow: m.context_length || 128000,
              supportsVision: Boolean(supportsVision),
              pricing: {
                inputPerM: Number((promptPricePerToken * 1_000_000).toFixed(3)),
                outputPerM: Number((compPricePerToken * 1_000_000).toFixed(3)),
              },
            };
          });

        if (mapped.length > 0) {
          this.cachedOpenRouterModels = mapped;
          this.lastModelsRefresh = Date.now();
        }
      }
    } catch (err) {
      this.logger.warn(`OpenRouter models refresh failed: ${(err as Error).message}`);
    }

    return this.getAvailableModels();
  }

  /**
   * Devolve todos os modelos disponíveis (locais + OpenRouter).
   */
  getAvailableModels(): AiModelInfo[] {
    const map = new Map<string, AiModelInfo>();
    for (const m of BUILTIN_MODELS) {
      // P3: Faturista só aparece se FATURISTA_URL estiver definida
      if (m.provider === 'faturista' && !this.faturista.isAvailable) {
        continue;
      }
      map.set(m.id, m);
    }
    for (const m of this.cachedOpenRouterModels) {
      if (!map.has(m.id)) {
        map.set(m.id, m);
      }
    }
    return Array.from(map.values());
  }

  /**
   * Testa a ligação a um fornecedor de IA.
   */
  async testConnection(input: {
    provider: string;
    apiKey?: string;
    model?: string;
  }): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const { provider } = input;
    const start = Date.now();

    if (provider === 'faturista') {
      return this.faturista.testConnection();
    }

    if (provider === 'openrouter') {
      const key = input.apiKey || this.config.get<string>('OPENROUTER_API_KEY');
      if (!key) {
        return { success: false, message: 'Chave OPENROUTER_API_KEY não configurada', latencyMs: 0 };
      }
      try {
        const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: { Authorization: `Bearer ${key}` },
        });
        const latency = Date.now() - start;
        if (res.ok) {
          return { success: true, message: 'Ligação à OpenRouter bem-sucedida', latencyMs: latency };
        }
        return { success: false, message: `OpenRouter respondeu com HTTP ${res.status}`, latencyMs: latency };
      } catch (err) {
        return { success: false, message: (err as Error).message, latencyMs: Date.now() - start };
      }
    }

    if (provider === 'anthropic') {
      const key = input.apiKey || this.config.get<string>('ANTHROPIC_API_KEY');
      if (!key) {
        return { success: false, message: 'Chave ANTHROPIC_API_KEY não configurada', latencyMs: 0 };
      }
      try {
        const Anthropic = require('@anthropic-ai/sdk').default;
        const client = new Anthropic({ apiKey: key });
        await client.messages.create({
          model: input.model || 'claude-3-5-haiku-20241022',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        });
        return { success: true, message: 'Ligação à Anthropic bem-sucedida', latencyMs: Date.now() - start };
      } catch (err) {
        return { success: false, message: (err as Error).message, latencyMs: Date.now() - start };
      }
    }

    if (provider === 'openai') {
      const key = input.apiKey || this.config.get<string>('OPENAI_API_KEY');
      if (!key) {
        return { success: false, message: 'Chave OPENAI_API_KEY não configurada', latencyMs: 0 };
      }
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        const latency = Date.now() - start;
        if (res.ok) {
          return { success: true, message: 'Ligação à OpenAI bem-sucedida', latencyMs: latency };
        }
        return { success: false, message: `OpenAI respondeu com HTTP ${res.status}`, latencyMs: latency };
      } catch (err) {
        return { success: false, message: (err as Error).message, latencyMs: Date.now() - start };
      }
    }

    if (provider === 'gemini') {
      const key =
        input.apiKey ||
        this.config.get<string>('GEMINI_API_KEY') ||
        this.config.get<string>('GOOGLE_API_KEY');
      if (!key) {
        return { success: false, message: 'Chave GEMINI_API_KEY não configurada', latencyMs: 0 };
      }
      try {
        const model = input.model || 'gemini-2.5-flash';
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${key}`,
        );
        const latency = Date.now() - start;
        if (res.ok) {
          return { success: true, message: 'Ligação à Google Gemini bem-sucedida', latencyMs: latency };
        }
        return { success: false, message: `Gemini respondeu com HTTP ${res.status}`, latencyMs: latency };
      } catch (err) {
        return { success: false, message: (err as Error).message, latencyMs: Date.now() - start };
      }
    }

    return {
      success: true,
      message: `Fornecedor ${provider} reconhecido`,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Agrega métricas acumuladas de telemetria IA a partir dos documentos do tenant.
   */
  async getMetrics(tenantId: string): Promise<AiMetricsDto> {
    const docs = await this.prisma.document.findMany({
      where: {
        tenantId,
      },
      select: {
        id: true,
        fileName: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    let totalEstimatedCostEur = 0;
    let totalProcessingTimeMs = 0;
    let totalConfidence = 0;
    let fallbackCount = 0;
    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const recentExtractions: AiMetricsDto['recentExtractions'] = [];

    for (const d of docs) {
      const meta = d.metadata as Record<string, any>;
      const ai = meta?.aiExtraction as Record<string, any> | undefined;
      if (!ai) continue;

      const provider = String(ai.provider || 'desconhecido');
      const model = String(ai.model || 'desconhecido');
      const cost = typeof ai.estimatedCostEur === 'number' ? ai.estimatedCostEur : 0;
      const timeMs = typeof ai.processingTimeMs === 'number' ? ai.processingTimeMs : 0;
      const conf = typeof ai.confidence === 'number' ? ai.confidence : 0.8;
      const fallback = ai.fallbackUsed === true;

      totalEstimatedCostEur += cost;
      totalProcessingTimeMs += timeMs;
      totalConfidence += conf;
      if (fallback) fallbackCount += 1;

      byProvider[provider] = (byProvider[provider] || 0) + 1;
      byModel[model] = (byModel[model] || 0) + 1;

      if (recentExtractions.length < 20) {
        recentExtractions.push({
          documentId: d.id,
          fileName: d.fileName,
          provider,
          model,
          processingTimeMs: timeMs,
          estimatedCostEur: Number(cost.toFixed(5)),
          confidence: Number(conf.toFixed(2)),
          fallbackUsed: fallback,
          timestamp: ai.timestamp || d.createdAt.toISOString(),
        });
      }
    }

    const total = docs.length;
    return {
      totalExtractions: total,
      totalEstimatedCostEur: Number(totalEstimatedCostEur.toFixed(4)),
      avgProcessingTimeMs: total > 0 ? Math.round(totalProcessingTimeMs / total) : 0,
      avgConfidence: total > 0 ? Number((totalConfidence / total).toFixed(2)) : 0,
      fallbackCount,
      fallbackRate: total > 0 ? Number(((fallbackCount / total) * 100).toFixed(1)) : 0,
      byProvider,
      byModel,
      recentExtractions,
    };
  }
}
