import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { FacebookAdsModule } from '../facebook-ads/facebook-ads.module';
import { PrismaModule } from '@n-database/prisma/prisma.module';

@Module({
    imports: [
        PrismaModule,
        FacebookAdsModule,
        HttpModule.register({
            timeout: 60000,
            maxRedirects: 5,
        }),
    ],
    controllers: [LeadsController],
    providers: [LeadsService],
    exports: [LeadsService],
})
export class LeadsModule { }
