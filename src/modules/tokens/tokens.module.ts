import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { TokensController } from './tokens.controller';
import { TokensService } from './services/tokens.service';

@Module({
  imports: [PrismaModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}

