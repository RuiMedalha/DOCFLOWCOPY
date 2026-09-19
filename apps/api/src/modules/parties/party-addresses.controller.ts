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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { THROTTLE_NAMES } from '../../common/throttle/throttle.constants';
import { PartyAddressesService } from './party-addresses.service';
import {
  CreatePartyAddressDto,
  UpdatePartyAddressDto,
} from './dto/party-address.dto';

/**
 * PartyAddressesController — CRUD on the per-Party address list.
 *
 * Routes (nested under `/parties/:partyId/addresses`):
 *   GET    /parties/:partyId/addresses        — list (any authenticated user)
 *   POST   /parties/:partyId/addresses        — create (ADMIN)
 *   PATCH  /parties/:partyId/addresses/:id    — partial update (ADMIN)
 *   DELETE /parties/:partyId/addresses/:id    — hard delete (ADMIN)
 *
 * Same RBAC pattern as PartyContactsController: reads open to any
 * authenticated user, mutations ADMIN-only (master-data follows the
 * PATCH /parties/:id gating convention).
 *
 * Rate limit (Sprint G review §4-A fix-up): POST/PATCH/DELETE share the
 * `master-write` bucket (30/min/tenant) — tighter than the global 100/60s
 * default to deter noisy scripts hammering master-data CRUD.
 */
@ApiTags('parties')
@ApiBearerAuth()
@Controller('parties/:partyId/addresses')
export class PartyAddressesController {
  constructor(private readonly addresses: PartyAddressesService) {}

  @Get()
  @ApiOperation({
    summary: 'List addresses for a party',
    description: 'Sorted by isPrimary DESC, type ASC. Tenant-scoped via session.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
  ) {
    return this.addresses.list(user.tenantId, partyId);
  }

  @Post()
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a new address to a party (ADMIN)' })
  @ApiResponse({ status: 201, description: 'Address created' })
  @ApiResponse({ status: 404, description: 'Party not found' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Body() dto: CreatePartyAddressDto,
  ) {
    return this.addresses.create(user.tenantId, user.id, partyId, dto);
  }

  @Patch(':id')
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update an address (ADMIN)' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePartyAddressDto,
  ) {
    return this.addresses.update(user.tenantId, user.id, partyId, id, dto);
  }

  @Delete(':id')
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard-delete an address (ADMIN)' })
  @ApiResponse({ status: 404, description: 'Address not found' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Param('id') id: string,
  ) {
    return this.addresses.remove(user.tenantId, user.id, partyId, id);
  }
}
