import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisPingService } from './redis-ping.service';
import { StorageService } from '../documents/storage/storage-service.interface';

/**
 * HealthController — two public probes, both @Public so monitors and
 * load balancers don't have to authenticate.
 *
 *   GET /api/v1/health        → cheap liveness (process up + DB SELECT 1)
 *   GET /api/v1/health/full   → deep readiness (DB + Redis + uptime + versions)
 *
 * Deep probe semantics:
 *  - Never includes error strings or connection strings in the response
 *    body — only "up"/"down" booleans.
 *  - Always returns HTTP 200 once the API process itself is alive. The
 *    readiness decision (mark the pod "NotReady" in K8s) should be made
 *    on the per-component flags, not on the HTTP status code.
 *  - A `degraded` status means one of the components is down. The process
 *    is still up, but it might fail higher-traffic requests.
 */
@ApiTags('health')
@Controller('health')
  @SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisPing: RedisPingService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Storage reachability — bucket HEAD (S3) or root-dir access (local). */
  private async storageState(): Promise<'up' | 'down'> {
    try {
      if (!this.storage.healthCheck) return 'up';
      return (await this.storage.healthCheck()) ? 'up' : 'down';
    } catch (err) {
      this.logger.error(
        `Health storage probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'down';
    }
  }

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Liveness + DB ping',
    description:
      'Returns { status, db, storage, storageDriver, ts }. Flags are "up" or "down" — never the error detail.',
  })
  async health(): Promise<{
    status: 'ok';
    db: 'up' | 'down';
    storage: 'up' | 'down';
    storageDriver: string;
    ts: string;
  }> {
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw<unknown[]>`SELECT 1`;
    } catch (err) {
      db = 'down';
      this.logger.error(
        `Health DB ping failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const storage = await this.storageState();
    return {
      status: 'ok',
      db,
      storage,
      storageDriver: this.storage.driver,
      ts: new Date().toISOString(),
    };
  }

  @Get('full')
  @Public()
  @ApiOperation({
    summary: 'Deep readiness probe',
    description:
      'Returns DB + Redis + storage state, uptime, build metadata. Always HTTP 200 — readiness lives in the per-component flags.',
  })
  async healthFull(): Promise<{
    status: 'ok' | 'degraded';
    components: {
      db: 'up' | 'down';
      redis: 'up' | 'down';
      storage: 'up' | 'down';
    };
    storageDriver: string;
    uptime_seconds: number;
    version: string;
    node_env: string;
    ts: string;
  }> {
    // DB ping
    let db: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw<unknown[]>`SELECT 1`;
    } catch (err) {
      db = 'down';
      this.logger.error(
        `Deep health DB ping failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Redis ping (lazy connect → disconnect)
    const redisOk = await this.redisPing.ping();
    const redis: 'up' | 'down' = redisOk ? 'up' : 'down';

    const storage = await this.storageState();

    return {
      status: db === 'up' && redis === 'up' && storage === 'up' ? 'ok' : 'degraded',
      components: { db, redis, storage },
      storageDriver: this.storage.driver,
      uptime_seconds: Math.round((Date.now() - this.startedAt) / 1000),
      version: process.env.APP_VERSION ?? '0.1.0',
      node_env: process.env.NODE_ENV ?? 'development',
      ts: new Date().toISOString(),
    };
  }
}
