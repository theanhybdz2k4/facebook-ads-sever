import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { FbAccountsController } from './fb-accounts.controller';
import { FbAccountsService } from './services/fb-accounts.service';

@Module({
  imports: [PrismaModule, SharedModule],
  controllers: [FbAccountsController],
  providers: [FbAccountsService],
  exports: [FbAccountsService],
})
export class FbAccountsModule {}

