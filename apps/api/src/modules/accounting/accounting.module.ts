import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';

/**
 * AccountingModule — static chart-of-accounts surface.
 *
 * Until the ChartOfAccounts Prisma model lands in a future sprint, this
 * module exposes the controller-only endpoint used by the document detail
 * page. No PrismaService injection needed (the list is hard-coded).
 */
@Module({
  controllers: [AccountingController],
})
export class AccountingModule {}
