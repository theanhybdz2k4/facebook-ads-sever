import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { IPlatformAdapter } from './platform-account.adapter.interface';
import { FacebookAdapter } from './implementations/facebook/facebook-account.adapter';

@Injectable()
export class PlatformsService {
  private readonly adapters: Map<string, IPlatformAdapter> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookAdapter: FacebookAdapter,
  ) {
    this.register(this.facebookAdapter);
  }

  private register(adapter: IPlatformAdapter) {
    this.adapters.set(adapter.platformCode, adapter);
  }

  getAdapter(platformCode: string): IPlatformAdapter {
    const adapter = this.adapters.get(platformCode);
    if (!adapter) {
      throw new NotFoundException(`Platform adapter for ${platformCode} not found`);
    }
    return adapter;
  }

  async findAll() {
    return this.prisma.platform.findMany({
      where: { isActive: true },
      orderBy: { id: 'asc' },
    });
  }

  async findByCode(code: string) {
    return this.prisma.platform.findUnique({
      where: { code },
    });
  }
}
