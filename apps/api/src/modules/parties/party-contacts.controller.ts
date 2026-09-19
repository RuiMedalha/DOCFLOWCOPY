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
import { PartyContactsService } from './party-contacts.service';
import {
  CreatePartyContactDto,
  UpdatePartyContactDto,
} from './dto/party-contact.dto';

/**
 * PartyContactsController — CRUD on the per-Party named-contact list.
 *
 * Routes (nested under `/parties/:partyId/contacts`):
 *   GET    /parties/:partyId/contacts        — list (any authenticated user)
 *   POST   /parties/:partyId/contacts        — create (ADMIN)
 *   PATCH  /parties/:partyId/contacts/:id    — partial update (ADMIN)
 *   DELETE /parties/:partyId/contacts/:id    — hard delete (ADMIN)
 *
 * Tenant isolation comes from `req.user.tenantId` (set by JwtGuard +
 * TenantGuard). RBAC: reads are any authenticated user (same as the IBAN
 * history endpoint); mutations are ADMIN — contacts are master data, the
 * same gate as PATCH /parties/:id.
 *
 * Rate limit (Sprint G review §4-A fix-up): POST/PATCH/DELETE share the
 * `master-write` bucket (30/min/tenant) — tighter than the global 100/60s
 * default to deter noisy scripts hammering master-data CRUD.
 */
@ApiTags('parties')
@ApiBearerAuth()
@Controller('parties/:partyId/contacts')
export class PartyContactsController {
  constructor(private readonly contacts: PartyContactsService) {}

  @Get()
  @ApiOperation({
    summary: 'List named contacts for a party',
    description: 'Newest first. Tenant-scoped via session.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
  ) {
    return this.contacts.list(user.tenantId, partyId);
  }

  @Post()
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a new named contact to a party (ADMIN)' })
  @ApiResponse({ status: 201, description: 'Contact created' })
  @ApiResponse({ status: 404, description: 'Party not found' })
  @ApiResponse({ status: 409, description: 'Duplicate email for this party' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Body() dto: CreatePartyContactDto,
  ) {
    return this.contacts.create(user.tenantId, user.id, partyId, dto);
  }

  @Patch(':id')
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a contact (ADMIN)' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  @ApiResponse({ status: 409, description: 'Duplicate email for this party' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePartyContactDto,
  ) {
    return this.contacts.update(user.tenantId, user.id, partyId, id, dto);
  }

  @Delete(':id')
  @Throttle({ [THROTTLE_NAMES.MASTER_WRITE]: { ttl: 60_000, limit: 30 } })
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard-delete a contact (ADMIN)' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  @ApiResponse({ status: 429, description: 'Too many master-data writes' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Param('id') id: string,
  ) {
    return this.contacts.remove(user.tenantId, user.id, partyId, id);
  }
}
