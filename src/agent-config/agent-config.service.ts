import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a helpful WhatsApp assistant.',
  'Keep replies concise, clear, and suitable for mobile chat.',
  'Ask a short follow-up question when you need more details.',
].join(' ');

export const DEFAULT_MODEL = 'gpt-5.5';

export type StoredAgentConfig = {
  systemPrompt: string | null;
  model: string | null;
  updatedAt: string | null;
};

@Injectable()
export class AgentConfigService implements OnModuleInit {
  private readonly logger = new Logger(AgentConfigService.name);
  private readonly pool: Pool;

  constructor(poolService: PgPoolService) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "AgentConfig" (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        "systemPrompt" TEXT,
        model TEXT,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.logger.log('Agent config storage is ready');
  }

  async getConfig(): Promise<StoredAgentConfig> {
    const result = await this.pool.query<StoredAgentConfig>(`
      SELECT "systemPrompt", model, "updatedAt"
      FROM "AgentConfig"
      WHERE id = 1
    `);

    return (
      result.rows[0] ?? { systemPrompt: null, model: null, updatedAt: null }
    );
  }

  async updateConfig(
    systemPrompt: string | null,
    model: string | null,
  ): Promise<StoredAgentConfig> {
    const result = await this.pool.query<StoredAgentConfig>(
      `
        INSERT INTO "AgentConfig" (id, "systemPrompt", model)
        VALUES (1, $1, $2)
        ON CONFLICT (id) DO UPDATE
        SET "systemPrompt" = $1, model = $2, "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "systemPrompt", model, "updatedAt"
      `,
      [systemPrompt, model],
    );

    return result.rows[0];
  }
}
