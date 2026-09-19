import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { StorageService } from '../documents/storage/storage-service.interface';

interface FsEntryDto {
  name: string;
  /** POSIX-style path RELATIVE to the tenant root, e.g. `_inbox/2026/09`. */
  path: string;
  kind: 'folder' | 'file';
  size?: number;
  modifiedAt?: string;
}

interface TreeResponseDto {
  /** POSIX path the caller asked for; `"/"` is the tenant root. */
  path: string;
  parent: string | null;
  folders: FsEntryDto[];
  files: FsEntryDto[];
}

@ApiTags('storage')
@Controller('storage')
export class StorageController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /**
   * GET /storage/tree?path=/<subdir>
   *
   * Lists the contents of `<uploadsRoot>/<tenantId>/<path>` for the
   * authenticated tenant. The path is sanitized against `..`, absolute
   * paths, NUL bytes, and traversal segments — anything that escapes the
   * tenant root returns 400.
   *
   * The route is gated by JwtGuard + TenantGuard globally; we never read
   * `tenantId` from the query string. Empty path means the tenant root.
   *
   * Driver-agnostic: delegates to `StorageService.list()` (filesystem
   * readdir for the local driver, ListObjectsV2 with delimiter for S3/MinIO).
   */
  @Get('tree')
  @ApiOperation({
    summary: 'List files and folders under a tenant path',
    description:
      'Returns immediate children of `<uploadsRoot>/<tenantId>/<path>`. ' +
      '`path` is the relative directory inside the tenant root (use `/` or ' +
      'empty for the root). Path traversal attempts return 400.',
  })
  @ApiQuery({
    name: 'path',
    required: false,
    example: '/_inbox/2026',
    description:
      'Tenant-scoped relative path. Default: `/`. Must NOT contain `..`.',
  })
  @ApiResponse({ status: 200, description: 'Tree node (folders + files)' })
  @ApiResponse({ status: 400, description: 'Invalid path (traversal, abs, NUL)' })
  @ApiResponse({ status: 404, description: 'Path does not exist' })
  async tree(
    @CurrentUser() user: AuthenticatedUser,
    @Query('path') rawPath?: string,
  ): Promise<TreeResponseDto> {
    const tenantId = user.tenantId;
    if (!tenantId) {
      // Defence in depth — JwtGuard should always set this, but if a future
      // refactor breaks the contract we refuse to list anything.
      throw new NotFoundException('tenant not resolved');
    }

    const cleaned = sanitizePath(rawPath ?? '/');
    const relativeToTenant = cleaned.replace(/^\/+/, '');
    // Tenant scoping happens here, never from caller input: the prefix
    // handed to the driver is always `<tenantId>/<sanitized path>`.
    const prefix = relativeToTenant ? `${tenantId}/${relativeToTenant}` : tenantId;

    if (!this.storage.list) {
      throw new NotFoundException('storage driver does not support listing');
    }
    const listing = await this.storage.list(prefix);

    const folders: FsEntryDto[] = listing.folders.map((f) => ({
      name: f.name,
      path: joinPosix(cleaned, f.name),
      kind: 'folder' as const,
    }));
    const files: FsEntryDto[] = listing.files.map((f) => ({
      name: f.name,
      path: joinPosix(cleaned, f.name),
      kind: 'file' as const,
      size: f.size,
      modifiedAt: f.modifiedAt,
    }));

    // Stable order: folders first by name, then files by name.
    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    return {
      path: cleaned,
      parent: parentOf(cleaned),
      folders,
      files,
    };
  }
}

/**
 * Sanitize a user-supplied tenant path. Rejects:
 *   - non-string / empty (treated as "/")
 *   - any segment equal to `..` or starting with `..` after split
 *   - absolute paths (leading `/` after trimming is allowed since the
 *     caller may pass `/inbox/2026` style paths)
 *   - NUL bytes
 *   - backslashes (Windows traversal via `..\\foo`)
 *   - control characters
 *
 * Returns a normalized POSIX path. Empty string → "/".
 */
function sanitizePath(raw: string): string {
  if (typeof raw !== 'string') return '/';
  let s = raw.trim();
  if (!s || s === '/') return '/';
  if (s.includes('\0')) {
    throw new BadRequestException('path contains NUL byte');
  }
  if (/[\x00-\x1f]/.test(s)) {
    throw new BadRequestException('path contains control character');
  }
  // Reject Windows-style backslashes entirely — we operate in POSIX.
  if (s.includes('\\')) {
    throw new BadRequestException('path uses backslashes');
  }
  // Strip leading slash for normalization, then re-add on output.
  const stripped = s.replace(/^\/+/, '');
  const segments = stripped.split('/').filter((seg) => seg.length > 0);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new BadRequestException('path traversal not allowed');
    }
  }
  return '/' + segments.join('/');
}

function joinPosix(parent: string, child: string): string {
  if (parent === '/' || parent === '') return '/' + child;
  return parent + '/' + child;
}

function parentOf(p: string): string | null {
  if (!p || p === '/' || p === '') return null;
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}
