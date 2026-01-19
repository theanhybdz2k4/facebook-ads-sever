import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '@n-modules/shared/shared.module';
import { AdGroupsController } from './ad-groups.controller';
import { AdGroupsService } from './services/ad-groups.service';

@Module({
  imports: [PrismaModule, SharedModule],
  controllers: [AdGroupsController],
  providers: [AdGroupsService],
  exports: [AdGroupsService],
})
export class AdGroupsModule { }
