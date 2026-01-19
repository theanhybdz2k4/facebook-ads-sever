import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class BulkUpsertService {
  private readonly logger = new Logger(BulkUpsertService.name);

  constructor(private readonly prisma: PrismaService) { }

  async execute(
    tableName: string,
    data: any[],
    uniqueCols: string[],
    updateCols: string[],
  ) {
    if (!data || data.length === 0) return 0;

    const columns = Object.keys(data[0]);
    const valuesList: string[] = [];
    const params: any[] = [];

    const numericCols = ['daily_budget', 'lifetime_budget', 'spend'];
    const intCols = ['hour'];
    const bigIntCols = ['impressions', 'reach', 'clicks', 'conversions', 'results'];
    const jsonCols = ['platform_data', 'platform_metrics', 'creative_data', 'targeting', 'creative'];
    const dateCols = ['date'];
    const timestampCols = ['start_time', 'end_time', 'synced_at', 'created_at', 'deleted_at'];
    const enumCols = ['status'];

    let paramIdx = 1;
    for (const item of data) {
      const rowParams = columns.map((col) => {
        let val = item[col];

        if (jsonCols.includes(col) && val !== null && typeof val === 'object') {
          val = JSON.stringify(val);
        }

        params.push(val);
        const placeholder = `$${paramIdx++}`;

        if (numericCols.includes(col)) return `${placeholder}::numeric`;
        if (intCols.includes(col)) return `${placeholder}::integer`;
        if (bigIntCols.includes(col)) return `${placeholder}::bigint`;
        if (jsonCols.includes(col)) return `${placeholder}::jsonb`;
        if (dateCols.includes(col)) return `${placeholder}::date`;
        if (timestampCols.includes(col)) return `${placeholder}::timestamp`;
        if (enumCols.includes(col)) return `${placeholder}::"UnifiedStatus"`;

        return placeholder;
      });
      valuesList.push(`(${rowParams.join(', ')})`);
    }

    const columnNames = columns.map(c => `"${c}"`).join(', ');
    const valuesPart = valuesList.join(', ');
    const conflictPart = uniqueCols.map(c => `"${c}"`).join(', ');

    // Aggressive casting in the update part
    const updatePart = updateCols
      .map((col) => {
        if (numericCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::numeric`;
        if (intCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::integer`;
        if (bigIntCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::bigint`;
        if (jsonCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::jsonb`;
        if (timestampCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::timestamp`;
        if (dateCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::date`;
        if (enumCols.includes(col)) return `"${col}" = EXCLUDED."${col}"::"UnifiedStatus"`;
        return `"${col}" = EXCLUDED."${col}"`;
      })
      .join(', ');

    const query = `
      INSERT INTO "${tableName}" (${columnNames})
      VALUES ${valuesPart}
      ON CONFLICT (${conflictPart})
      DO UPDATE SET ${updatePart}
    `;

    try {
      this.logger.log(`Executing Bulk Upsert on ${tableName}`);
      return await this.prisma.$executeRawUnsafe(query, ...params);
    } catch (error) {
      this.logger.error(`Bulk upsert failed for table ${tableName}: ${error.message}`);
      this.logger.error(`Sample data: ${JSON.stringify(data[0], (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
      throw error;
    }
  }

  toSnakeCase(obj: any): any {
    const snakeObj: any = {};
    for (const key in obj) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      snakeObj[snakeKey] = obj[key];
    }
    return snakeObj;
  }
}
