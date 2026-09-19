import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { DocumentsService } from './documents.service';
import {
  SupplierResponseDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

/**
 * SupplierController — Sprint H+ Part 2.
 *
 * Splits the supplier surface away from DocumentsController so the
 * re-extract (POST /:id/supplier/re-extract) and the strict
 * manual-edit (POST /:id/supplier/update) routes can evolve without
 * touching the legacy correct-supplier / soft-delete endpoints.
 *
 * Both routes inherit the global JwtAuthGuard + TenantGuard +
 * RbacGuard stack — `@Roles(ADMIN, OPERADOR)` is the second filter.
 * Cross-tenant ids surface as 404 inside the service (tenant-scoped
 * findFirst) so the controller never sees a foreign doc.
 *
 * Mounted at the same `/documents` prefix as DocumentsController;
 * the `@Controller('documents')` decorator resolves the prefix.
 */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class SupplierController {
  constructor(private readonly documents: DocumentsService) {}

  // ─────────────────────────────────────────── re-extract ──────────────────

  @Post(':id/supplier/re-extract')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary:
      'Re-run the AI vision + OCR pipeline focused on the supplier block',
    description:
      "Re-reads the file bytes from storage, runs vision + regex, and persists just the supplier-shaped fields (name / NIF / IBAN / country) on the Document. Refuses with 409 when `Document.supplierVerifiedAt` is set unless `?force=true` is passed — that's the Operator-Verified Guard that prevents a silent AI hallucination from overwriting an operator's explicit confirmation. Customer / totals / line items / party links are NOT touched.",
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: String,
    description:
      'Pass `force=true` to overwrite a previously verified supplier block. Otherwise the call returns 409.',
  })
  @ApiResponse({
    status: 200,
    description: 'Supplier block refreshed',
    type: SupplierResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Document not found (or cross-tenant)',
  })
  @ApiResponse({
    status: 409,
    description:
      'Document.supplierVerifiedAt is set — pass `?force=true` to overwrite',
  })
  async reExtractSupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('force') forceRaw?: string,
  ): Promise<{
    ok: true;
    reExtracted: boolean;
    supplier: SupplierResponseDto;
  }> {
    const force = forceRaw === 'true' || forceRaw === '1';
    const result = await this.documents.extractSupplierFromDocument(
      user.tenantId,
      user.id,
      id,
      { force },
    );
    return {
      ok: true,
      reExtracted: result.reExtracted,
      supplier: {
        supplierName: result.supplier.name,
        supplierNif: result.supplier.nif,
        supplierIban: result.supplier.iban,
        supplierAddress: result.supplier.address,
        supplierCountry: result.supplier.country,
        reExtracted: result.reExtracted,
      },
    };
  }

  // ─────────────────────────────────────────── update ─────────────────────

  @Post(':id/supplier/update')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR)
  @ApiOperation({
    summary:
      'Strict-validation manual edit of the supplier block (Part 2 backend companion to /correct-supplier)',
    description:
      'Overwrites the Document.supplier / supplierNif / iban fields with the operator-supplied values, runs the structural mod-11 NIF + mod-97 IBAN validators (from `common/validation/tax-id.validator.ts`), writes a forensic audit row tagged `document.update_supplier` with a BEFORE/AFTER diff, and re-publishes `document.uploaded` so the enrichment pipeline re-runs. Address + country land in `metadata.supplierAddress` / `metadata.supplierCountry` (the schema does not have dedicated columns for those).',
  })
  @ApiResponse({
    status: 200,
    description: 'Supplier block updated; pipeline re-triggered',
    type: SupplierResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error — NIF fails mod-11, IBAN fails mod-97, or no field supplied',
  })
  @ApiResponse({
    status: 404,
    description: 'Document not found (or cross-tenant)',
  })
  async updateSupplier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ): Promise<{
    ok: true;
    supplier: SupplierResponseDto;
  }> {
    // Refuse the "empty payload" case — at least one supplier field
    // MUST be supplied. Without this guard the endpoint would silently
    // succeed with no-op writes (auditing a phantom edit is worse than
    // refusing it).
    if (
      dto.name === undefined &&
      dto.nif === undefined &&
      dto.iban === undefined &&
      dto.address === undefined &&
      dto.country === undefined
    ) {
      throw new BadRequestException(
        'At least one of name/nif/iban/address/country must be supplied',
      );
    }

    const result = await this.documents.updateSupplier(
      user.tenantId,
      user.id,
      id,
      dto,
    );
    return {
      ok: true,
      supplier: {
        supplierName: result.supplier.name,
        supplierNif: result.supplier.nif,
        supplierIban: result.supplier.iban,
        supplierAddress: result.supplier.address,
        supplierCountry: result.supplier.country,
      },
    };
  }
}
