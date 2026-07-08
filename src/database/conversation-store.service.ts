import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export type ConversationRole = 'USER' | 'ASSISTANT';

export type ConversationMessageRecord = {
  id: number;
  role: ConversationRole;
  content: string;
};

export type ConversationStore = {
  findLatestMessages(
    phoneNumber: string,
    limit: number,
  ): Promise<ConversationMessageRecord[]>;
  saveTurn(
    phoneNumber: string,
    userText: string,
    assistantText: string,
    maxMessages: number,
  ): Promise<void>;
};

@Injectable()
export class ConversationStoreService
  implements ConversationStore, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConversationStoreService.name);
  private readonly pool: Pool;

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

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async findLatestMessages(
    phoneNumber: string,
    limit: number,
  ): Promise<ConversationMessageRecord[]> {
    const result = await this.pool.query<ConversationMessageRecord>(
      `
        SELECT id, role, content
        FROM "ConversationMessage"
        WHERE "phoneNumber" = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [phoneNumber, limit],
    );

    return result.rows.reverse();
  }

  async saveTurn(
    phoneNumber: string,
    userText: string,
    assistantText: string,
    maxMessages: number,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `
          INSERT INTO "ConversationMessage" ("phoneNumber", role, content)
          VALUES ($1, $2, $3), ($1, $4, $5)
        `,
        [phoneNumber, 'USER', userText, 'ASSISTANT', assistantText],
      );
      await client.query(
        `
          DELETE FROM "ConversationMessage"
          WHERE id IN (
            SELECT id
            FROM "ConversationMessage"
            WHERE "phoneNumber" = $1
            ORDER BY id DESC
            OFFSET $2
          )
        `,
        [phoneNumber, maxMessages],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'ConversationRole'
        ) THEN
          CREATE TYPE "ConversationRole" AS ENUM ('USER', 'ASSISTANT');
        END IF;
      END
      $$;
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "ConversationMessage" (
        id SERIAL PRIMARY KEY,
        "phoneNumber" TEXT NOT NULL,
        role "ConversationRole" NOT NULL,
        content TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS "ConversationMessage_phoneNumber_id_idx"
      ON "ConversationMessage"("phoneNumber", id);
    `);

    this.logger.log('Conversation message storage is ready');
  }
}
