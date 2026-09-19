import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Sprint H — PATCH /tenants/me/settings payload.
 *
 * Mass-assignment hardening (security-audit §3 / H-4): the DTO is a
 * strict whitelist. The global ValidationPipe runs with
 * `whitelist: true, forbidNonWhitelisted: true`, so a body like
 * `{ autoApprove: true, id: 'other-tenant', role: 'OWNER' }` will
 * be rejected with a 400. Anything added here MUST be a real
 * settings field — never a sneaky cross-tenant write.
 */
export class UpdateTenantSettingsDto {
  @ApiProperty({
    description:
      'When true, the processing pipeline auto-approves documents that ' +
      'have a partyId linked. Always combined with the in-pipeline guard ' +
      'that refuses unattributed documents.',
    example: false,
  })
  @IsBoolean()
  autoApprove!: boolean;
}
