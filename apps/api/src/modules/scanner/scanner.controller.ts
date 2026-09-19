import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/guards/rbac.guard';
import { ScannerService } from './scanner.service';

/**
 * ScannerController — operator endpoints to manage the file-watcher.
 *
 * The endpoints are guarded by RBAC (ADMIN/GESTOR_RH) because flipping
 * the watcher into `running` makes the API begin ingesting files
 * dropped into a shared folder; that should not be exposed to plain
 * tenant users.
 */
@ApiTags('Scanner')
@ApiBearerAuth()
@Controller('scanner')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  @Post('start')
  @Roles(Role.ADMIN, Role.GESTOR_RH)
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the scanner file-watcher' })
  async start() {
    return this.scanner.start();
  }

  @Post('stop')
  @Roles(Role.ADMIN, Role.GESTOR_RH)
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the scanner file-watcher' })
  async stop() {
    return this.scanner.stop();
  }

  @Get('status')
  @ApiOperation({ summary: 'Return current scanner state + watch path' })
  status() {
    return this.scanner.getStatus();
  }
}
