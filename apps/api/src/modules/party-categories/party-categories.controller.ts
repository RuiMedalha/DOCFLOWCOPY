import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '../../common/guards/rbac.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PartyCategoriesService } from './party-categories.service';
import {
  CreatePartyCategoryDto,
  PartyCategoryQueryDto,
  UpdatePartyCategoryDto,
} from './dto/party-category.dto';

@ApiTags('party-categories')
@ApiBearerAuth()
@Controller('party-categories')
export class PartyCategoriesController {
  constructor(private readonly svc: PartyCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List party categories for the current tenant (auto-seeds defaults on first call)' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PartyCategoryQueryDto,
  ) {
    await this.svc.ensureSeedForTenant(user.tenantId);
    return this.svc.list(user.tenantId, query);
  }

  @Get(':id')
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.svc.getOrThrow(user.tenantId, id);
  }

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a party category (ADMIN only)' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePartyCategoryDto,
  ) {
    return this.svc.create(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePartyCategoryDto,
  ) {
    return this.svc.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.svc.remove(user.tenantId, id);
  }
}
