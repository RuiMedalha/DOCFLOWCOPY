import {
  Body,
  Controller,
  Get,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { TenantsService } from './tenants.service';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';

/**
 * Sprint H — Tenants settings controller.
 *
 * PATCH /tenants/me/settings
 *   - Body: UpdateTenantSettingsDto (whitelisted; mass-assignment safe)
 *   - RBAC: ADMIN or OWNER only (security-audit H-4)
 *   - Auth: global JwtGuard + TenantGuard + RbacGuard
 *   - Audit: tenants.service writes an audit row on every write.
 *
 * GET /tenants/me/settings
 *   - Any authenticated tenant member can read. The endpoint returns
 *     only the tenant's own settings — never another tenant's.
 */
@ApiTags('tenants')
@ApiBearerAuth()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('me/settings')
  @ApiOperation({
    summary: 'Get the current tenant settings',
    description:
      'Returns the settings JSON for the authenticated tenant. Empty object if no settings have been set yet.',
  })
  async getSettings(@CurrentUser() user: AuthenticatedUser): Promise<{ settings: Record<string, unknown> }> {
    const settings = await this.tenants.get(user.tenantId);
    return { settings };
  }

  @Patch('me/settings')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update the current tenant settings',
    description:
      'Mass-assignment safe (whitelisted DTO). ADMIN role only. ' +
      'Writes a `tenant.settings.update` audit row.',
  })
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateTenantSettingsDto,
  ): Promise<{ settings: Record<string, unknown> }> {
    const next = await this.tenants.update(
      user.tenantId,
      user.id,
      { autoApprove: dto.autoApprove },
    );
    return { settings: next };
  }
}
