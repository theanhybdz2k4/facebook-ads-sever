import { PrismaClient } from '@prisma/client';
import { Kysely } from 'kysely';
import { Prisma } from '@prisma/client';

export class PrismaClientExtended extends PrismaClient {
  kysely: Kysely<any>;
}

