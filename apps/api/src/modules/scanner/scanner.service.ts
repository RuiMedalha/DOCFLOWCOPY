import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar, { FSWatcher } from 'chokidar';
import { DocumentOrigin } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundService } from '../inbound/inbound.service';

/**
 * ScannerService — file-watcher backed by chokidar that picks up new files
 * dropped into the configured watch path and ingests them through the
 * existing `InboundService.ingestFiles` pipeline with `origin: SCANNER`.
 *
 * Design choices (Sprint F brief §5):
 *   - **Global** watch path (`apps/api/uploads/scanner/`). Per-tenant sub-
 *     folders resolve the ambiguity without requiring per-tenant watcher
 *     handles.
 *   - `awaitWriteFinish` debounces the file-finished event so a half-
 *     written PDF doesn't get ingested (2s stability threshold).
 *   - MIME validation piggybacks on `InboundService.ingestFiles` so the
 *     same hard rules (`ACCEPTED_MIME_TYPES`, `ACCEPTED_EXTENSIONS`)
 *     apply — no duplicated allow-lists.
 *   - State is in-memory; restart resets to `stopped`. The operator can
 *     re-enable the watcher via `POST /scanner/start`.
 *   - On 'add' we look up the tenant by the leading `<tenantId>-` segment
 *     of the filename. Filenames without a tenant prefix are skipped
 *     (logged as warning) so an unrelated file drop doesn't accidentally
 *     pollute the inbox of an arbitrary tenant.
 */
@Injectable()
export class ScannerService implements OnModuleDestroy {
  private readonly logger = new Logger(ScannerService.name);
  private watcher: FSWatcher | null = null;
  private state: 'running' | 'stopped' = 'stopped';
  private readonly watchPath: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => InboundService))
    private readonly inbound: InboundService,
  ) {
    this.watchPath = path.resolve(
      process.env.SCANNER_PATH ?? path.join(process.cwd(), 'uploads', 'scanner'),
    );
  }

  /**
   * Open the chokidar watcher. Idempotent — calling `start()` while the
   * watcher is already running is a no-op so the controller does not
   * need to track state.
   */
  async start(): Promise<{ state: 'running'; watchPath: string }> {
    if (this.state === 'running' && this.watcher) {
      return { state: 'running', watchPath: this.watchPath };
    }
    await fs.mkdir(this.watchPath, { recursive: true });
    // Pre-create the `.processed/` subdir so the first ingest doesn't
    // race on directory creation. chokidar already ignores dotfile
    // paths via the regex at line 73, so files moved here will not be
    // re-fired as 'add'.
    await fs.mkdir(path.join(this.watchPath, '.processed'), { recursive: true });

    const watcher = chokidar.watch(this.watchPath, {
      ignoreInitial: true,
      // Wait until the file size has been stable for 2s before firing
      // 'add'. PDFs from a network scanner or copy operation can take a
      // few seconds to land on disk; 2s is the SCOUT-recommended default.
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100,
      },
      ignored: /(^|[/\\])\../, // dotfiles
      depth: 4,
    });

    watcher.on('add', (filePath: string) => {
      void this.handleAdd(filePath).catch((err) => {
        this.logger.error(
          `scanner ingest failed for ${filePath}: ${(err as Error).message}`,
        );
      });
    });

    watcher.on('error', (err: unknown) => {
      this.logger.error(`scanner watcher error: ${this.messageOf(err)}`);
    });

    this.watcher = watcher;
    this.state = 'running';
    this.logger.log(`scanner watcher started on ${this.watchPath}`);
    return { state: 'running', watchPath: this.watchPath };
  }

  async stop(): Promise<{ state: 'stopped'; watchPath: string }> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.state = 'stopped';
    this.logger.log('scanner watcher stopped');
    return { state: 'stopped', watchPath: this.watchPath };
  }

  getStatus(): { state: 'running' | 'stopped'; watchPath: string } {
    return { state: this.state, watchPath: this.watchPath };
  }

  async onModuleDestroy() {
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
  }

  /**
   * Extract the tenant id from the leading segment of the filename
   * (`<tenantId>__<rest>`), validate that the tenant exists and is
   * active, and route the file through the standard inbound pipeline.
   * Unknown / malformed filenames are skipped with a warning so the
   * watcher does not block on junk files.
   *
   * The `__` separator (double underscore) is intentional — cuids used
   * as tenant ids may contain a single hyphen, which would otherwise
   * collide with our filename convention.
   */
  private async handleAdd(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const sepIndex = fileName.indexOf('__');
    if (sepIndex <= 0) {
      this.logger.warn(
        `scanner skipped ${fileName} — missing <tenantId>__<file> prefix`,
      );
      return;
    }

    const tenantId = fileName.slice(0, sepIndex);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, active: true },
    });
    if (!tenant?.active) {
      this.logger.warn(
        `scanner skipped ${fileName} — tenant ${tenantId} is missing or inactive`,
      );
      return;
    }

    const buffer = await fs.readFile(filePath);
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const mime = this.mimeForExt(ext);
    if (!mime) {
      this.logger.warn(
        `scanner skipped ${fileName} — unsupported extension .${ext}`,
      );
      return;
    }

    await this.inbound.ingestFiles(
      tenant.id,
      [
        {
          buffer,
          originalname: fileName.slice(sepIndex + 2),
          mimetype: mime,
          size: buffer.length,
        },
      ],
      DocumentOrigin.SCANNER,
      { source: 'file-watcher', scannedFilename: fileName },
    );
    this.logger.log(`scanner ingested ${fileName} for tenant ${tenant.id}`);

    // Move the processed file to `.processed/` so subsequent restarts
    // (or an admin touching the file) do not re-ingest it. A failure
    // here is non-fatal — the ingest already succeeded and the next
    // ingest would be a no-op via the fileHash dedup path.
    const processedDir = path.join(path.dirname(filePath), '.processed');
    try {
      await fs.mkdir(processedDir, { recursive: true });
      await fs.rename(filePath, path.join(processedDir, fileName));
    } catch (err) {
      this.logger.warn(
        `scanner could not move ${fileName} to .processed/: ${(err as Error).message}`,
      );
    }
  }

  private mimeForExt(ext: string): string | null {
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] ?? null;
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
