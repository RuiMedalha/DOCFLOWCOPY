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
import { PartyTimelineService } from './party-timeline.service';

/**
 * PartyTimelineController — read-only aggregation of all events that
 * touched a party. Aggregates AuditLog, PaymentEvent (via Document),
 * IbanHistory, and Document.APROVADO. Cursor-based infinite scroll.
 *
 * GET /parties/:partyId/timeline?cursor=&limit=20
 */
@ApiTags('parties')
@ApiBearerAuth()
@Controller('parties/:partyId/timeline')
export class PartyTimelineController {
  constructor(private readonly timeline: PartyTimelineService) {}

  @Get()
  @ApiOperation({
    summary: 'Aggregate timeline of party events',
    description:
      'Merges AuditLog, PaymentEvent (via Document JOIN), IbanHistory, and ' +
      'APROVADO Document rows. Sorted by timestamp desc with composite ' +
      'timestamp+id cursor pagination to avoid losing events that share a ms.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque base64url cursor from the previous page',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '1..50 (default 20)',
  })
  @ApiResponse({ status: 200, description: '{ items: TimelineEvent[], nextCursor: string | null }' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('partyId') partyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : 20;
    return this.timeline.list(
      user.tenantId,
      partyId,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : 20,
    );
  }
}
