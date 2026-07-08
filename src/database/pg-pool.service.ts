import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class PgPoolService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(configService: ConfigService) {
    const databaseUrl = configService.get<string>('DATABASE_URL')?.trim();

    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
