import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';

export type KnowledgeEntry = {
  id: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class KnowledgebaseService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgebaseService.name);
  private readonly pool: Pool;

  constructor(poolService: PgPoolService) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "KnowledgeEntry" (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.logger.log('Knowledgebase storage is ready');
  }

  async list(): Promise<KnowledgeEntry[]> {
    const result = await this.pool.query<KnowledgeEntry>(`
      SELECT id, title, content, "createdAt", "updatedAt"
      FROM "KnowledgeEntry"
      ORDER BY id DESC
    `);

    return result.rows;
  }

  async create(title: string, content: string): Promise<KnowledgeEntry> {
    const result = await this.pool.query<KnowledgeEntry>(
      `
        INSERT INTO "KnowledgeEntry" (title, content)
        VALUES ($1, $2)
        RETURNING id, title, content, "createdAt", "updatedAt"
      `,
      [title, content],
    );

    return result.rows[0];
  }

  async update(
    id: number,
    title: string,
    content: string,
  ): Promise<KnowledgeEntry | null> {
    const result = await this.pool.query<KnowledgeEntry>(
      `
        UPDATE "KnowledgeEntry"
        SET title = $2, content = $3, "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, title, content, "createdAt", "updatedAt"
      `,
      [id, title, content],
    );

    return result.rows[0] ?? null;
  }

  async remove(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM "KnowledgeEntry" WHERE id = $1`,
      [id],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
