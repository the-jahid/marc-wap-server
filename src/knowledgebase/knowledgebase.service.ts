import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';
import type { DocumentTextService } from './document-text.service';
import type {
  KnowledgeVectorMatch,
  KnowledgebaseVectorService,
} from './knowledgebase-vector.service';
import type { UploadedKnowledgeFile } from './uploaded-knowledge-file.type';

const MAX_KNOWLEDGEBASE_CONTEXT_CHARS = 24_000;
const MAX_VECTOR_ERROR_CHARS = 1000;

export type KnowledgeEntry = {
  id: number;
  title: string;
  content: string;
  sourceType: 'text' | 'document';
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  chunkCount: number;
  vectorStatus: 'pending' | 'indexed' | 'not_configured' | 'failed';
  vectorError: string | null;
  vectorRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeVectorState = Pick<
  KnowledgeEntry,
  'chunkCount' | 'vectorStatus' | 'vectorError'
>;

type KnowledgeEntryRow = KnowledgeEntry & {
  sourceType: 'text' | 'document';
};

type FreshVectorRow = {
  id: number;
  vectorRevision: number;
};

const KNOWLEDGE_ENTRY_SELECT = `
  id,
  title,
  content,
  "sourceType",
  "fileName",
  "mimeType",
  "byteSize",
  "chunkCount",
  "vectorStatus",
  "vectorError",
  "vectorRevision",
  "createdAt",
  "updatedAt"
`;

@Injectable()
export class KnowledgebaseService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgebaseService.name);
  private readonly pool: Pool;
  private documentTextService: DocumentTextService | null = null;
  private vectorService: KnowledgebaseVectorService | null = null;

  constructor(
    poolService: PgPoolService,
    private readonly configService: ConfigService,
  ) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "KnowledgeEntry" (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        "sourceType" TEXT NOT NULL DEFAULT 'text',
        "fileName" TEXT,
        "mimeType" TEXT,
        "byteSize" INTEGER,
        "chunkCount" INTEGER NOT NULL DEFAULT 0,
        "vectorStatus" TEXT NOT NULL DEFAULT 'pending',
        "vectorError" TEXT,
        "vectorRevision" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await this.pool.query(`
      ALTER TABLE "KnowledgeEntry"
      ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'text',
      ADD COLUMN IF NOT EXISTS "fileName" TEXT,
      ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
      ADD COLUMN IF NOT EXISTS "byteSize" INTEGER,
      ADD COLUMN IF NOT EXISTS "chunkCount" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "vectorStatus" TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS "vectorError" TEXT,
      ADD COLUMN IF NOT EXISTS "vectorRevision" INTEGER NOT NULL DEFAULT 1;
    `);

    this.logger.log('Knowledgebase storage is ready');
  }

  async list(): Promise<KnowledgeEntry[]> {
    const result = await this.pool.query<KnowledgeEntry>(`
      SELECT ${KNOWLEDGE_ENTRY_SELECT}
      FROM "KnowledgeEntry"
      ORDER BY id DESC
    `);

    return result.rows;
  }

  async create(title: string, content: string): Promise<KnowledgeEntry> {
    const result = await this.pool.query<KnowledgeEntry>(
      `
        INSERT INTO "KnowledgeEntry" (
          title,
          content,
          "sourceType",
          "vectorStatus"
        )
        VALUES ($1, $2, 'text', 'pending')
        RETURNING ${KNOWLEDGE_ENTRY_SELECT}
      `,
      [title, content],
    );

    return this.syncVectors(result.rows[0]);
  }

  async uploadDocument(
    file: UploadedKnowledgeFile,
    title?: string,
  ): Promise<KnowledgeEntry> {
    const documentTextService = await this.getDocumentTextService();
    const content = await documentTextService.extractText(file);
    const entryTitle = title?.trim() || file.originalname;
    const result = await this.pool.query<KnowledgeEntry>(
      `
        INSERT INTO "KnowledgeEntry" (
          title,
          content,
          "sourceType",
          "fileName",
          "mimeType",
          "byteSize",
          "vectorStatus"
        )
        VALUES ($1, $2, 'document', $3, $4, $5, 'pending')
        RETURNING ${KNOWLEDGE_ENTRY_SELECT}
      `,
      [
        entryTitle,
        content,
        file.originalname,
        file.mimetype || 'application/octet-stream',
        file.size,
      ],
    );

    return this.syncVectors(result.rows[0]);
  }

  async update(
    id: number,
    title: string,
    content: string,
  ): Promise<KnowledgeEntry | null> {
    const result = await this.pool.query<KnowledgeEntry>(
      `
        UPDATE "KnowledgeEntry"
        SET
          title = $2,
          content = $3,
          "chunkCount" = 0,
          "vectorStatus" = 'pending',
          "vectorError" = NULL,
          "vectorRevision" = "vectorRevision" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING ${KNOWLEDGE_ENTRY_SELECT}
      `,
      [id, title, content],
    );
    const entry = result.rows[0] ?? null;

    return entry ? this.syncVectors(entry) : null;
  }

  async remove(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM "KnowledgeEntry" WHERE id = $1`,
      [id],
    );
    const deleted = (result.rowCount ?? 0) > 0;

    if (!deleted) {
      return false;
    }

    if (!this.isVectorSearchConfigured()) {
      return true;
    }

    try {
      const vectorService = await this.getVectorService();

      await vectorService.deleteEntry(id);
    } catch (error) {
      this.logger.warn(
        `Deleted knowledge entry ${id}, but failed to delete Pinecone vectors`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return true;
  }

  async buildContextForQuestion(question: string): Promise<string> {
    if (this.isVectorSearchConfigured()) {
      try {
        const vectorService = await this.getVectorService();
        const matches = await vectorService.search(question);
        const freshMatches = await this.filterFreshVectorMatches(matches);

        if (freshMatches.length > 0) {
          return this.formatVectorContext(freshMatches);
        }
      } catch (error) {
        this.logger.warn(
          'Failed to query Pinecone knowledgebase; falling back to stored entries',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return this.formatStoredContext(await this.list());
  }

  async setVectorState(
    id: number,
    state: KnowledgeVectorState,
  ): Promise<KnowledgeEntry | null> {
    return this.updateVectorState(id, state);
  }

  private async syncVectors(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    if (!this.isVectorSearchConfigured()) {
      return (
        (await this.updateVectorState(entry.id, {
          chunkCount: 0,
          vectorStatus: 'not_configured',
          vectorError:
            'Set OPENAI_API_KEY, PINECONE_API_KEY, and PINECONE_INDEX_NAME or PINECONE_INDEX_HOST to enable vector search.',
        })) ?? entry
      );
    }

    const vectorService = await this.getVectorService();
    const result = await vectorService.upsertEntry(entry);

    return (
      (await this.updateVectorState(entry.id, {
        chunkCount: result.chunkCount,
        vectorStatus: result.status,
        vectorError: result.error,
      })) ?? entry
    );
  }

  private async updateVectorState(
    id: number,
    state: KnowledgeVectorState,
  ): Promise<KnowledgeEntry | null> {
    const result = await this.pool.query<KnowledgeEntry>(
      `
        UPDATE "KnowledgeEntry"
        SET
          "chunkCount" = $2,
          "vectorStatus" = $3,
          "vectorError" = $4
        WHERE id = $1
        RETURNING ${KNOWLEDGE_ENTRY_SELECT}
      `,
      [
        id,
        state.chunkCount,
        state.vectorStatus,
        state.vectorError?.slice(0, MAX_VECTOR_ERROR_CHARS) ?? null,
      ],
    );

    return result.rows[0] ?? null;
  }

  private async getDocumentTextService(): Promise<DocumentTextService> {
    let documentTextService = this.documentTextService;

    if (!documentTextService) {
      const { DocumentTextService } = await import(
        './document-text.service.js'
      );

      documentTextService = new DocumentTextService();
      this.documentTextService = documentTextService;
    }

    return documentTextService;
  }

  private async getVectorService(): Promise<KnowledgebaseVectorService> {
    let vectorService = this.vectorService;

    if (!vectorService) {
      const { KnowledgebaseVectorService } = await import(
        './knowledgebase-vector.service.js'
      );

      vectorService = new KnowledgebaseVectorService(this.configService);
      this.vectorService = vectorService;
    }

    return vectorService;
  }

  private isVectorSearchConfigured(): boolean {
    const openAiApiKey = this.configService
      .get<string>('OPENAI_API_KEY')
      ?.trim();
    const pineconeApiKey = this.configService
      .get<string>('PINECONE_API_KEY')
      ?.trim();
    const pineconeIndexName = this.configService
      .get<string>('PINECONE_INDEX_NAME')
      ?.trim();
    const pineconeIndexHost = this.configService
      .get<string>('PINECONE_INDEX_HOST')
      ?.trim();

    return Boolean(
      openAiApiKey &&
        pineconeApiKey &&
        (pineconeIndexName || pineconeIndexHost),
    );
  }

  private async filterFreshVectorMatches(
    matches: KnowledgeVectorMatch[],
  ): Promise<KnowledgeVectorMatch[]> {
    const entryIds = [...new Set(matches.map((match) => match.entryId))];

    if (entryIds.length === 0) {
      return [];
    }

    const result = await this.pool.query<FreshVectorRow>(
      `
        SELECT id, "vectorRevision"
        FROM "KnowledgeEntry"
        WHERE id = ANY($1::int[])
      `,
      [entryIds],
    );
    const revisionsById = new Map(
      result.rows.map((row) => [row.id, row.vectorRevision]),
    );

    return matches.filter(
      (match) => revisionsById.get(match.entryId) === match.vectorRevision,
    );
  }

  private formatVectorContext(matches: KnowledgeVectorMatch[]): string {
    return matches
      .map((match) => {
        const source =
          match.sourceType === 'document' && match.fileName
            ? `${match.title} (${match.fileName})`
            : match.title;

        return `### ${source}\n${match.text}`;
      })
      .join('\n\n')
      .slice(0, MAX_KNOWLEDGEBASE_CONTEXT_CHARS);
  }

  private formatStoredContext(entries: KnowledgeEntryRow[]): string {
    if (entries.length === 0) {
      return '';
    }

    return entries
      .map((entry) => {
        const source =
          entry.sourceType === 'document' && entry.fileName
            ? `${entry.title} (${entry.fileName})`
            : entry.title;

        return `### ${source}\n${entry.content}`;
      })
      .join('\n\n')
      .slice(0, MAX_KNOWLEDGEBASE_CONTEXT_CHARS);
  }
}
