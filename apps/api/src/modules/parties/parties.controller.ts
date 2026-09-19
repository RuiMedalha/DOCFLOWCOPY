import {
  BadRequestException,
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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { PartiesService } from './parties.service';
import { ViesService } from '../vies/vies.service';
import { PartyImportService } from './party-import.service';
import { PartyProductsService } from './party-products.service';
import { PartyMergeService } from './party-merge.service';
import { UploadedFile, UseInterceptors, BadRequestException as PartiesBadRequest } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from '../documents/documents.service';
import {
  AccountQueryDto,
  CreateAccountDto,
  UpdateAccountDto,
} from './dto/account.dto';
import {
  CreatePartyDto,
  FlagIbanDto,
  MarkVerifiedIbanDto,
  MergePartyDto,
  PartyQueryDto,
  UpdatePartyDto,
} from './dto/party.dto';

/**
 * PartiesController — supplier/customer master + PT chart of accounts.
 *
 * Routes:
 *   PARTIES (CRUD)
 *     GET    /parties                       — list (paginated, filterable)
 *     POST   /parties                       — create (validates NIF + IBAN)
 *     GET    /parties/:id                   — detail
 *     PATCH  /parties/:id                   — partial update
 *     DELETE /parties/:id                   — soft-delete (isActive=false)
 *
 *   IBAN ANTI-FRAUD
 *     GET    /parties/:id/iban-history      — audit trail
 *     POST   /parties/:id/iban/verify       — mark verified
 *     POST   /parties/:id/iban/flag         — flag + write blacklist
 *     GET    /parties/:id/iban/risk-score   — 0..100 score
 *     GET    /parties/blacklist             — list blacklisted IBANs
 *     POST   /parties/blacklist             — add IBAN to blacklist
 *
 *   ACCOUNTS (PT PGC)
 *     GET    /accounts                      — paginated listing
 *     GET    /accounts/seed                 — seed accounts (id + code + name)
 *     GET    /accounts/:id                  — detail
 *     POST   /accounts                      — create
 *     PATCH  /accounts/:id                  — partial update
 *     DELETE /accounts/:id                  — soft-delete (isActive=false)
 *
 * Auth: every route goes through the global JwtGuard + TenantGuard +
 * RbacGuard (APP_GUARD). Tenants are auto-scoped via the Prisma extension.
 *
 * IBAN history / anti-fraud: RBAC is intentionally NOT role-gated — every
 * authenticated user needs to verify a vendor's IBAN when entering a new
 * expense. The audit log records the user who made each call.
 */
@ApiTags('parties')
@ApiBearerAuth()
@Controller()
export class PartiesController {
  constructor(
    private readonly parties: PartiesService,
    private readonly documents: DocumentsService,
    private readonly vies: ViesService,
    private readonly partyImport: PartyImportService,
    private readonly partyProducts: PartyProductsService,
    private readonly partyMerge: PartyMergeService,
  ) {}

  // ── Fase 4 ─────────────────────────────────────────────────────────
  @Post('parties/import')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({
    summary: 'Import suppliers from CSV (Moloni export or any CSV)',
    description:
      'multipart/form-data: `file` (CSV, UTF-8, `;` or `,`), optional `mapping` (JSON string: DocFlow field → CSV column), optional `dryRun=true`. Upsert by NIF / NIF-IVA / exact name.',
  })
  importCsv(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('mapping') mapping?: string,
    @Body('dryRun') dryRun?: string,
    @Body('type') type?: string,
  ) {
    if (!file?.buffer?.length) throw new PartiesBadRequest('CSV file is required (field "file")');
    let parsedMapping: Record<string, string> | undefined;
    if (mapping) {
      try {
        parsedMapping = JSON.parse(mapping);
      } catch {
        throw new PartiesBadRequest('mapping must be a JSON object');
      }
    }
    return this.partyImport.importCsv(user.tenantId, user.id, file.buffer, parsedMapping, {
      dryRun: dryRun === 'true' || dryRun === '1',
      type: type === 'CLIENTE' || type === 'AMBOS' ? (type as 'CLIENTE' | 'AMBOS') : undefined,
    });
  }

  @Post('parties/:id/vies')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate the party VAT number in VIES (EC REST API, 30-day cache)' })
  validateVies(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.vies.validateParty(user.tenantId, id, force === 'true' || force === '1');
  }

  // ── Fase 4.1 — fundir entidades ────────────────────────────────────
  // Em produção o mesmo fornecedor ficou partido por várias Party (três
  // "CreateInfor"). Esta rota corrige o que já está partido; o
  // party-identity impede que volte a acontecer.
  @Get('parties/duplicates')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Grupos de entidades que parecem ser o mesmo fornecedor',
    description:
      'Agrupa por NIF ou por nome normalizado (sem acentos, sem formas jurídicas) + país. '
      + 'Sugere como destino a mais antiga que tenha NIF.',
  })
  duplicates(@CurrentUser() user: AuthenticatedUser) {
    return this.partyMerge.findDuplicates(user.tenantId);
  }

  @Post('parties/:id/merge')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fundir outra entidade nesta (move documentos, contactos, IBANs e histórico)',
    description:
      'O `:id` é o DESTINO (sobrevive); `sourceId` no corpo é a entidade absorvida, '
      + 'que fica inativa mas nunca é apagada. Recusa fundir entidades que não partilhem '
      + 'NIF nem nome normalizado. Fica registado na auditoria.',
  })
  mergeParty(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MergePartyDto,
  ) {
    return this.partyMerge.merge(user.tenantId, user.id, id, dto.sourceId);
  }

  @Get('parties/:id/products')
  @ApiOperation({ summary: 'Products bought from this supplier (aggregated document line items)' })
  products(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.partyProducts.list(user.tenantId, id);
  }

  // ─────────────────────────────────────────── parties CRUD ───────────────

  @Get('parties')
  @ApiOperation({
    summary: 'List parties (fornecedores/clientes/ambos)',
    description:
      'Paginated. Filters: type (FORNECEDOR|CLIENTE|AMBOS), isActive (default true), search over name/nif/email/iban/city.',
  })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PartyQueryDto,
  ) {
    return this.parties.findAll(user.tenantId, query);
  }

  @Post('parties')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a party (fornecedor/cliente/ambos)',
    description:
      'Validates NIF (mod-11) and IBAN (ISO 7064 MOD-97-10) before persisting. Refuses to create when NIF already exists for the tenant.',
  })
  @ApiResponse({ status: 201, description: 'Party created' })
  @ApiResponse({ status: 400, description: 'Invalid NIF / IBAN' })
  @ApiResponse({ status: 409, description: 'NIF already exists for this tenant' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePartyDto,
  ) {
    return this.parties.create(user.tenantId, user.id, dto);
  }

  // ──────────────────────────────────────────── accounts alias ────────────
  //
  // NestJS routes are matched in declaration order. Because the parties
  // CRUD routes below use `@Get('parties/:id')`, a request to
  // `/parties/accounts` was being captured as id="accounts" and returning
  // 404. Declaring this alias BEFORE the `:id` route restores the canonical
  // endpoint without breaking the existing `/accounts` root path used by
  // most clients.

  @Get('parties/accounts')
  @ApiOperation({
    summary: 'Alias for GET /accounts (chart of accounts)',
    description:
      'Canonical path was `/accounts`; this alias exists so the URL `/parties/accounts` ' +
      'still works and is not shadowed by `parties/:id`. Returns the same paginated listing.',
  })
  findAllAccountsUnderParties(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AccountQueryDto,
  ) {
    return this.parties.findAllAccounts(user.tenantId, query);
  }

  @Get('parties/accounts/seed')
  @ApiOperation({
    summary: 'Alias for GET /accounts/seed (UI dropdown helper)',
  })
  listSeedAccountsUnderParties(@CurrentUser() user: AuthenticatedUser) {
    return this.parties.listSeedAccounts(user.tenantId);
  }

  @Get('parties/:id')
  @ApiOperation({ summary: 'Get party detail' })
  @ApiResponse({ status: 404, description: 'Party not found' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.findOne(user.tenantId, id);
  }

  /**
   * Recent documents linked to a party. Powers the "Faturas recentes"
   * section on `/parties/:id`. Same shape as `GET /documents` so the
   * UI can reuse its list primitives — and so the "Ver todas" button
   * just redirects to `/documents?partyId=...` (which the documents
   * controller already accepts).
   */
  @Get('parties/:id/documents')
  @ApiOperation({
    summary: 'List documents linked to this party (supplier/customer)',
    description:
      'Paginates by limit (default 10, capped at 50). Optional from/to ' +
      'filter the createdAt range. Returns the same { items, meta } shape ' +
      'as GET /documents so the UI list primitive is shared.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '1..50 (default 10)' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date — inclusive' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date — inclusive' })
  @ApiResponse({ status: 200, description: 'Paginated documents for the party' })
  @ApiResponse({ status: 404, description: 'Party not found' })
  async findPartyDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // Validate the party exists in this tenant before returning an
    // empty list — keeps 404 vs empty-list semantics predictable for
    // the UI (which renders a "no docs" card vs an error toast).
    await this.parties.findOne(user.tenantId, id);
    const parsedLimit = limit ? Number(limit) : 10;
    return this.documents.findByParty(
      user.tenantId,
      id,
      Number.isFinite(parsedLimit) ? parsedLimit : 10,
      from,
      to,
    );
  }

  @Patch('parties/:id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update a party',
    description:
      'Partial update. IBAN change detection writes a row to IbanHistory automatically.',
  })
  @ApiResponse({ status: 404, description: 'Party not found' })
  @ApiResponse({ status: 400, description: 'Invalid NIF / IBAN' })
  @ApiResponse({
    status: 403,
    description: 'Only ADMIN may set isRecurring / isRecurringManualOverride',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePartyDto,
  ) {
    return this.parties.update(user.tenantId, user.id, id, dto, user.role);
  }

  @Delete('parties/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Soft-delete a party',
    description: 'Sets isActive=false; the row stays queryable for audit.',
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.softDelete(user.tenantId, user.id, id);
  }

  // ─────────────────────────────────────────── IBAN history ───────────────

  @Get('parties/:id/iban-history')
  @ApiOperation({
    summary: 'IBAN change history for a party',
    description:
      'Anti-fraud audit trail. Every IBAN change records (oldIban, newIban, changedBy, reason, verified).',
  })
  listIbanHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.listIbanHistory(user.tenantId, id);
  }

  // ─────────────────────────────────────────── IBAN anti-fraud ─────────────

  @Post('parties/:id/iban/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark the party IBAN as verified by a human',
    description: 'Sets ibanVerified=true, ibanVerifiedAt=now, ibanFlagged=false.',
  })
  verifyIban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MarkVerifiedIbanDto,
  ) {
    return this.parties.markIbanVerified(user.tenantId, user.id, id, dto);
  }

  @Post('parties/:id/iban/flag')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Flag the party IBAN as risky',
    description:
      'Sets ibanFlagged=true and adds the IBAN to the tenant blacklist if missing.',
  })
  flagIban(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FlagIbanDto,
  ) {
    return this.parties.flagIban(user.tenantId, user.id, id, dto);
  }

  @Get('parties/:id/iban/risk-score')
  @ApiOperation({
    summary: 'Compute a 0..100 risk score for the party IBAN',
    description:
      'Combines blacklist hit, syntax validity, recent-change count, country, and manual verification. Returns a breakdown with each contributing factor.',
  })
  riskScore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.riskScore(user.tenantId, id);
  }

  @Get('parties/blacklist')
  @ApiOperation({ summary: 'List all IBANs in the tenant blacklist' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listBlacklist(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.parties.listBlacklist(
      user.tenantId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
    );
  }

  @Post('parties/blacklist')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an IBAN to the tenant blacklist' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['iban', 'reason'],
      properties: {
        iban: { type: 'string' },
        reason: { type: 'string' },
        source: { type: 'string', enum: ['manual', 'fraud-network', 'validation'] },
      },
    },
  })
  addToBlacklist(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { iban: string; reason: string; source?: string },
  ) {
    if (!body?.iban) throw new BadRequestException('iban is required');
    if (!body?.reason) throw new BadRequestException('reason is required');
    return this.parties.addToBlacklist(user.tenantId, user.id, body);
  }

  // ─────────────────────────────────────────── accounts ───────────────────

  @Get('accounts')
  @ApiOperation({
    summary: 'List accounts (PT PGC chart of accounts)',
    description: 'Paginated. Filters: type, parentCode, isActive, search.',
  })
  findAllAccounts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AccountQueryDto,
  ) {
    return this.parties.findAllAccounts(user.tenantId, query);
  }

  @Get('accounts/seed')
  @ApiOperation({
    summary: 'List seed accounts (id + code + name + type)',
    description:
      'Used by the UI to populate dropdowns (default Debit/Credit account pickers) without having to fetch the whole chart.',
  })
  listSeedAccounts(@CurrentUser() user: AuthenticatedUser) {
    return this.parties.listSeedAccounts(user.tenantId);
  }

  @Get('accounts/:id')
  @ApiOperation({ summary: 'Get account detail' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  findOneAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.findOneAccount(user.tenantId, id);
  }

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Refuses to create when code already exists for the tenant. parentId/parentCode must resolve to an existing row.',
  })
  @ApiResponse({ status: 409, description: 'Duplicate code' })
  createAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAccountDto,
  ) {
    return this.parties.createAccount(user.tenantId, user.id, dto);
  }

  @Patch('accounts/:id')
  @ApiOperation({ summary: 'Update an account' })
  updateAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.parties.updateAccount(user.tenantId, user.id, id, dto);
  }

  @Delete('accounts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete an account' })
  removeAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.parties.softDeleteAccount(user.tenantId, user.id, id);
  }
}
