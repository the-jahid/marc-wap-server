import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from './pg-pool.service';

export type ConversationRole = 'USER' | 'ASSISTANT';

export type ConversationMessageRecord = {
  id: number;
  role: ConversationRole;
  content: string;
};

export type ConversationMessageWithTimestamp = ConversationMessageRecord & {
  createdAt: string;
};

export type ConversationSummary = {
  phoneNumber: string;
  lastMessage: string;
  lastRole: ConversationRole;
  lastActivityAt: string;
  messageCount: number;
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
  implements ConversationStore, OnModuleInit
{
  private readonly logger = new Logger(ConversationStoreService.name);
  private readonly pool: Pool;

  constructor(poolService: PgPoolService) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
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

  async listConversations(): Promise<ConversationSummary[]> {
    const result = await this.pool.query<ConversationSummary>(
      `
        SELECT DISTINCT ON ("phoneNumber")
          "phoneNumber",
          content AS "lastMessage",
          role AS "lastRole",
          "createdAt" AS "lastActivityAt",
          COUNT(*) OVER (PARTITION BY "phoneNumber")::int AS "messageCount"
        FROM "ConversationMessage"
        ORDER BY "phoneNumber", id DESC
      `,
    );

    return result.rows.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );
  }

  async findAllMessages(
    phoneNumber: string,
  ): Promise<ConversationMessageWithTimestamp[]> {
    const result = await this.pool.query<ConversationMessageWithTimestamp>(
      `
        SELECT id, role, content, "createdAt"
        FROM "ConversationMessage"
        WHERE "phoneNumber" = $1
        ORDER BY id ASC
      `,
      [phoneNumber],
    );

    return result.rows;
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
