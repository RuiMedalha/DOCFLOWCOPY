import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../common/guards/rbac.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ApprovalsService } from './approvals.service';
import {
  APPROVAL_STATUSES,
  ApprovalListItemDto,
  ApproveApprovalDto,
  ListApprovalsQueryDto,
  RejectApprovalDto,
  RequestApprovalDto,
  RequestChangesDto,
} from './dto/approval.dto';

/**
 * ApprovalsController — Sprint 1.B invoice-approval workflow.
 *
 * Endpoints:
 *   POST   /api/v1/documents/:id/request-approval  → OPERADOR (any tenant user)
 *   POST   /api/v1/approvals/:id/approve           → APPROVER / ADMIN
 *   POST   /api/v1/approvals/:id/reject            → APPROVER / ADMIN
 *   POST   /api/v1/approvals/:id/request-changes   → APPROVER / ADMIN
 *   GET    /api/v1/approvals?status=…              → every tenant user
 *   GET    /api/v1/documents/:id/approval-history  → every tenant user
 *
 * The role gate for the three decide endpoints is at the
 * controller layer (NestJS RBAC); the self-decide guard is
 * inside the service (since it depends on who the requester was,
 * not the caller's role).
 */

@ApiTags('approvals')
@ApiBearerAuth()
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  // ─── Request approval (open a new request) ──────────────────────────

  @Post('documents/:id/request-approval')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.OPERADOR, Role.APPROVER, Role.CONTABILIDADE)
  @ApiOperation({
    summary: 'Open an approval request for a document',
    description:
      'Creates an Approval row in status PENDING, flips Document.status to PENDING_APPROVAL and points Document.currentApprovalId at the new row. Pre-conditions: Document must be in status NOVO and must have supplierVerifiedAt set. Cross-tenant ids surface as 404; a second concurrent request returns 409.',
  })
  @ApiResponse({ status: 200, description: 'Approval request opened' })
  @ApiResponse({ status: 400, description: 'supplierVerifiedAt is not set' })
  @ApiResponse({ status: 404, description: 'Document not found (or cross-tenant)' })
  @ApiResponse({ status: 409, description: 'Document already has a pending approval / wrong status' })
  async requestApproval(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RequestApprovalDto,
  ): Promise<{ approvalId: string; verifiedAt: string }> {
    return this.approvals.requestApproval(user.tenantId, user.id, id, dto.comment);
  }

  // ─── Decide endpoints ───────────────────────────────────────────────

  @Post('approvals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.APPROVER)
  @ApiOperation({
    summary: 'Approve a pending approval',
    description:
      'Flips Approval.status to APPROVED and Document.status to APROVADO. The self-decide guard prevents the original requester from approving their own request even if they hold the APPROVER role. Already-decided rows return 409.',
  })
  @ApiResponse({ status: 200, description: 'Approval approved' })
  @ApiResponse({ status: 403, description: 'Requester cannot decide on their own request' })
  @ApiResponse({ status: 404, description: 'Approval not found (or cross-tenant)' })
  @ApiResponse({ status: 409, description: 'Approval already decided' })
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ApproveApprovalDto,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    return this.approvals.approve(
      user.tenantId,
      user.id,
      user.role,
      id,
      dto.comment,
    );
  }

  @Post('approvals/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.APPROVER)
  @ApiOperation({
    summary: 'Reject a pending approval (comment mandatory)',
    description:
      'Flips Approval.status to REJECTED and Document.status to REJEITADO. `comment` is mandatory — the controller returns 400 when missing/empty. Same self-decide guard as approve.',
  })
  @ApiResponse({ status: 200, description: 'Approval rejected' })
  @ApiResponse({ status: 400, description: 'comment is required' })
  @ApiResponse({ status: 403, description: 'Requester cannot decide on their own request' })
  @ApiResponse({ status: 404, description: 'Approval not found (or cross-tenant)' })
  @ApiResponse({ status: 409, description: 'Approval already decided' })
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectApprovalDto,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    if (!dto.comment || dto.comment.trim() === '') {
      throw new BadRequestException('comment is required for reject');
    }
    return this.approvals.reject(
      user.tenantId,
      user.id,
      user.role,
      id,
      dto.comment,
    );
  }

  @Post('approvals/:id/request-changes')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.ADMIN, Role.APPROVER)
  @ApiOperation({
    summary: 'Request changes on a pending approval (comment mandatory)',
    description:
      'Flips Approval.status to CHANGES_REQUESTED and Document.status to CHANGES_REQUESTED so the requester knows to re-submit. `comment` is mandatory — the controller returns 400 when missing/empty. Same self-decide guard as approve.',
  })
  @ApiResponse({ status: 200, description: 'Changes requested' })
  @ApiResponse({ status: 400, description: 'comment is required' })
  @ApiResponse({ status: 403, description: 'Requester cannot decide on their own request' })
  @ApiResponse({ status: 404, description: 'Approval not found (or cross-tenant)' })
  @ApiResponse({ status: 409, description: 'Approval already decided' })
  async requestChanges(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RequestChangesDto,
  ): Promise<{ approvalId: string; documentId: string; decidedAt: string }> {
    if (!dto.comment || dto.comment.trim() === '') {
      throw new BadRequestException('comment is required for request-changes');
    }
    return this.approvals.requestChanges(
      user.tenantId,
      user.id,
      user.role,
      id,
      dto.comment,
    );
  }

  // ─── Listings ───────────────────────────────────────────────────────

  @Get('approvals')
  @ApiOperation({
    summary: 'List approvals for the tenant (optionally filtered by status)',
    description:
      'Returns the most-recent first. Joins Document + User metadata so the UI does not need N+1 round-trips per row. Open to every authenticated member of the tenant.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: APPROVAL_STATUSES,
  })
  @ApiResponse({
    status: 200,
    description: 'Approvals list',
    type: ApprovalListItemDto,
    isArray: true,
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListApprovalsQueryDto,
  ): Promise<ApprovalListItemDto[]> {
    return this.approvals.list(user.tenantId, { status: query.status });
  }

  @Get('documents/:id/approval-history')
  @ApiOperation({
    summary: 'Full approval history for a document',
    description:
      'Returns every approval row ever opened for the document (most-recent first), including decided ones. Powers the timeline widget on the document detail page.',
  })
  @ApiResponse({ status: 200, description: 'Approval history' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ApprovalListItemDto[]> {
    return this.approvals.historyForDocument(user.tenantId, id);
  }

  // Sidebar badge — cheap aggregate query the dashboard polls
  // every 30s. Route sits under `/approvals` (not `/approvals/...`)
  // so the listing filter (`GET /approvals?status=…`) and the
  // count endpoint both live under the same parent path.
  @SkipThrottle()
  @Get('approvals/pending-count')
  @ApiOperation({
    summary: 'Count of PENDING approvals in the tenant (for the sidebar badge)',
    description:
      'Cheap aggregate: returns a single number so the sidebar can poll without scanning the full approvals list. Tenant-scoped; cross-tenant callers get 0.',
  })
  @ApiResponse({ status: 200, description: 'Count of pending approvals' })
  async pendingCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    const count = await this.approvals.pendingCount(user.tenantId);
    return { count };
  }
}
