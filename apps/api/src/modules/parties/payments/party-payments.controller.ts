import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PartyPaymentsService } from './party-payments.service';

/**
 * PartyPaymentsController — read-only listing of PaymentEvents for a party.
 *
 * GET /parties/:partyId/payments?cursor=&limit=20
 *
 * The cursor is the LAST row's id from the previous page (returned in
 * `nextCursor`). Pass it back to get the next page; when `nextCursor`
 * is null, you've reached the end.
 */
@ApiTags('parties')
@ApiBearerAuth()
@Controller('parties/:partyId/payments')
export class PartyPaymentsController {
  constructor(private readonly payments: PartyPaymentsService) {}

  @Get()
  @ApiOperation({
    summary: 'List payment events for a party (joined via Document.partyId)',
    description:
      'PaymentEvent has no direct partyId FK — the join goes through ' +
      'Document.partyId. Sorted by dueDate DESC. Cursor-based pagination.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'id of the last row from the previous page',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '1..50 (default 20)',
  })
  @ApiResponse({ status: 200, description: '{ items: PaymentEvent[], nextCursor: string | null }' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : 20;
    return this.payments.list(
      user.tenantId,
      partyId,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : 20,
    );
  }
}
