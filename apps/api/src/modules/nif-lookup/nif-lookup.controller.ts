import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { NifLookupService } from './nif-lookup.service';

/**
 * NifLookupController — Sprint 1.C Portal das Finanças integration.
 *
 * Single endpoint:
 *   GET /nif/:nif/validate
 *     Returns the full lookup payload — mod11 verdict, base
 *     hit/miss, optional name + address. The rate-limit guard
 *     lives in the service; the controller maps the thrown
 *     sentinel to 429.
 *
 * RBAC: any authenticated tenant member (the lookup itself
 * is cheap + public). We deliberately do NOT gate this on
 * ADMIN/ACCOUNTANT so the detail page can show "Validar NIF"
 * to every operator that needs the verdict.
 */
@ApiTags('nif-lookup')
@ApiBearerAuth()
@Controller('nif')
export class NifLookupController {
  constructor(private readonly nif: NifLookupService) {}

  @Get(':nif/validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a PT NIF against the structural checksum + the public base',
    description:
      'Runs mod-11 first, then a cached or live lookup against the Portal das Finanças. Returns `{ valid, mod11Valid, baseVerified, reason?, name?, address?, source, fetchedAt }`. Audit-logs every call (LGPD: the public-record lookup is permitted, but we still want a forensic trail).',
  })
  @ApiResponse({
    status: 200,
    description: 'NIF verdict',
    schema: {
      type: 'object',
      properties: {
        nif: { type: 'string' },
        mod11Valid: { type: 'boolean' },
        baseVerified: { type: 'boolean' },
        reason: { type: 'string' },
        name: { type: 'string' },
        address: { type: 'string' },
        source: { type: 'string', enum: ['cache', 'upstream', 'mod11_only'] },
        fetchedAt: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Empty NIF' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (10 req/min per tenant)' })
  async validate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('nif') nif: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    if (!nif || nif.trim().length === 0) {
      throw new BadRequestException('NIF parameter is required');
    }
    try {
      const result = await this.nif.lookup(user.tenantId, user.id, nif);
      // Surface the rate-limit window so a polling client can
      // back off without burning a slot for nothing.
      res.setHeader(
        'X-RateLimit-Limit',
        '10',
      );
      res.setHeader('X-RateLimit-Remaining', '0');
      return result;
    } catch (err) {
      const msg = (err as Error)?.message ?? '';
      if (msg.startsWith('RATE_LIMIT:')) {
        throw new HttpException(
          {
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'NIF lookup rate limit exceeded for this tenant (10 req/min). Retry in <60s.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }
}
