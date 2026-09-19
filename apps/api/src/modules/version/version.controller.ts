import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';

export interface VersionResponse {
  commit: string;
  buildTime: string;
  version: string;
}

@ApiTags('version')
@Controller('version')
@SkipThrottle()
export class VersionController {
  private readonly versionInfo: VersionResponse;

  constructor() {
    let commit =
      process.env.GIT_COMMIT ||
      process.env.COMMIT_SHA ||
      process.env.COOLIFY_COMMIT_SHA ||
      process.env.SOURCE_COMMIT ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      '';

    if (!commit) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execSync } = require('child_process');
        commit = execSync('git rev-parse --short HEAD', { timeout: 1500 })
          .toString()
          .trim();
      } catch {
        commit = 'local';
      }
    }

    const buildTime =
      process.env.BUILD_TIME ||
      process.env.BUILD_TIMESTAMP ||
      new Date().toISOString();

    const version =
      process.env.APP_VERSION ||
      process.env.DOCFLOW_VERSION ||
      '4.3.0';

    this.versionInfo = {
      commit,
      buildTime,
      version,
    };
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Current API version, commit SHA and build time' })
  getVersion(): VersionResponse {
    return this.versionInfo;
  }
}
