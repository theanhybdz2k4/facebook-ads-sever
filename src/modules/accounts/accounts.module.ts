import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { AdAccountsController } from './ad-accounts.controller';
import { PlatformsModule } from '../platforms/platforms.module';
import { SharedModule } from '@n-modules/shared/shared.module';

@Module({
  imports: [SharedModule, PlatformsModule],
  providers: [AccountsService],
  controllers: [AccountsController, AdAccountsController],
  exports: [AccountsService],
})
export class AccountsModule { }
