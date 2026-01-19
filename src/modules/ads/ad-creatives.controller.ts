import { Controller, Post, Param, Body, ParseIntPipe, ParseArrayPipe } from '@nestjs/common';
import { CreativeSyncService } from './services/creative-sync.service';

@Controller('ads/creatives')
export class AdCreativesController {
  constructor(private readonly creativeSync: CreativeSyncService) {}

  @Post('account/:accountId')
  async syncAccountCreatives(@Param('accountId', ParseIntPipe) accountId: number) {
    return this.creativeSync.syncByAccount(accountId);
  }

  @Post('sync')
  async syncByIds(@Body('adIds', new ParseArrayPipe({ items: String })) adIds: string[]) {
    return this.creativeSync.syncByIds(adIds);
  }
}
