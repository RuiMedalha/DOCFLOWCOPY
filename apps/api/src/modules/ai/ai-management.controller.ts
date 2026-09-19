import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { TenantRequestContext } from '../../common/context/tenant-context';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RbacGuard, Role } from '../../common/guards/rbac.guard';
import {
  AiManagementService,
  AiSettingsDto,
  AiMetricsDto,
  AiModelInfo,
} from './ai-management.service';

@ApiTags('ai-management')
@ApiBearerAuth()
@UseGuards(TenantGuard, RbacGuard)
@Controller('ai')
export class AiManagementController {
  constructor(private readonly aiManagement: AiManagementService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Obter configurações e roteamento de modelos de IA do tenant' })
  async getSettings(@CurrentTenant() tenant: TenantRequestContext): Promise<AiSettingsDto> {
    return this.aiManagement.getSettings(tenant.tenantId);
  }

  @Put('settings')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Atualizar configurações e tarefas de modelos de IA do tenant' })
  async updateSettings(
    @CurrentTenant() tenant: TenantRequestContext,
    @Body()
    body: {
      defaultProvider?: string;
      taskRouting?: {
        triage?: string;
        extraction?: string;
        enrichment?: string;
      };
    },
  ): Promise<AiSettingsDto> {
    return this.aiManagement.updateSettings(tenant.tenantId, body);
  }

  @Get('models')
  @ApiOperation({ summary: 'Listar todos os modelos de IA disponíveis' })
  getModels(): { models: AiModelInfo[] } {
    return { models: this.aiManagement.getAvailableModels() };
  }

  @Post('models/refresh')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Atualizar catálogo de modelos via OpenRouter' })
  async refreshModels(): Promise<{ models: AiModelInfo[] }> {
    const models = await this.aiManagement.refreshOpenRouterModels();
    return { models };
  }

  @Post('test-connection')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Testar conexão com fornecedor de IA' })
  async testConnection(
    @Body()
    body: {
      provider: string;
      apiKey?: string;
      model?: string;
    },
  ): Promise<{ success: boolean; message: string; latencyMs: number }> {
    return this.aiManagement.testConnection(body);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Métricas agregadas de utilização de IA e telemetria' })
  async getMetrics(@CurrentTenant() tenant: TenantRequestContext): Promise<AiMetricsDto> {
    return this.aiManagement.getMetrics(tenant.tenantId);
  }
}
