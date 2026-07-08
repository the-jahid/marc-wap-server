import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';
import {
  Pinecone,
  type Index,
  type PineconeRecord,
  type RecordMetadata,
} from '@pinecone-database/pinecone';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_NAMESPACE = 'knowledgebase';
const DEFAULT_CHUNK_CHARS = 1400;
const DEFAULT_CHUNK_OVERLAP_CHARS = 180;
const DEFAULT_TOP_K = 5;
const MAX_VECTOR_ERROR_CHARS = 1000;

export type IndexableKnowledgeEntry = {
  id: number;
  title: string;
  content: string;
  sourceType: string;
  fileName: string | null;
  mimeType: string | null;
  vectorRevision: number;
};

export type KnowledgeVectorSyncResult = {
  status: 'indexed' | 'not_configured' | 'failed';
  chunkCount: number;
  error: string | null;
};

export type KnowledgeVectorMatch = {
  entryId: number;
  vectorRevision: number;
  title: string;
  text: string;
  sourceType: string;
  fileName: string | null;
  score: number | null;
};

type KnowledgeVectorMetadata = RecordMetadata & {
  entryId: number;
  vectorRevision: number;
  chunkIndex: number;
  title: string;
  text: string;
  sourceType: string;
  fileName: string;
  mimeType: string;
};

type VectorConfig = {
  openAiApiKey: string;
  pineconeApiKey: string;
  pineconeIndexName: string | null;
  pineconeIndexHost: string | null;
  namespace: string;
  embeddingModel: string;
  embeddingDimensions: number | undefined;
};

type VectorClients = {
  index: Index<KnowledgeVectorMetadata>;
  embeddings: OpenAIEmbeddings;
};

@Injectable()
export class KnowledgebaseVectorService {
  private readonly logger = new Logger(KnowledgebaseVectorService.name);
  private cachedClients: VectorClients | null = null;
  private cachedClientKey: string | null = null;

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return this.getVectorConfig() !== null;
  }

  async upsertEntry(
    entry: IndexableKnowledgeEntry,
  ): Promise<KnowledgeVectorSyncResult> {
    let clients: VectorClients | null;

    try {
      clients = this.getClients();
    } catch (error) {
      const message = this.errorToMessage(error);

      return {
        status: 'failed',
        chunkCount: 0,
        error: message.slice(0, MAX_VECTOR_ERROR_CHARS),
      };
    }

    if (!clients) {
      return {
        status: 'not_configured',
        chunkCount: 0,
        error:
          'Set OPENAI_API_KEY, PINECONE_API_KEY, and PINECONE_INDEX_NAME or PINECONE_INDEX_HOST to enable vector search.',
      };
    }

    const chunks = this.chunkText(entry.content);

    if (chunks.length === 0) {
      return { status: 'failed', chunkCount: 0, error: 'No text to index' };
    }

    try {
      await this.deleteEntry(entry.id);

      for (let start = 0; start < chunks.length; start += 50) {
        const batch = chunks.slice(start, start + 50);
        const vectors = await clients.embeddings.embedDocuments(batch);
        const records: Array<PineconeRecord<KnowledgeVectorMetadata>> =
          batch.map((chunk, batchIndex) => {
            const chunkIndex = start + batchIndex;

            return {
              id: `kb:${entry.id}:${entry.vectorRevision}:${chunkIndex}`,
              values: vectors[batchIndex],
              metadata: {
                entryId: entry.id,
                vectorRevision: entry.vectorRevision,
                chunkIndex,
                title: entry.title,
                text: chunk,
                sourceType: entry.sourceType,
                fileName: entry.fileName ?? '',
                mimeType: entry.mimeType ?? '',
              },
            };
          });

        await clients.index.upsert({ records });
      }

      return { status: 'indexed', chunkCount: chunks.length, error: null };
    } catch (error) {
      const message = this.errorToMessage(error);
      this.logger.warn(
        `Failed to index knowledge entry ${entry.id} in Pinecone: ${message}`,
      );

      return {
        status: 'failed',
        chunkCount: 0,
        error: message.slice(0, MAX_VECTOR_ERROR_CHARS),
      };
    }
  }

  async deleteEntry(entryId: number): Promise<void> {
    const clients = this.getClients();

    if (!clients) {
      return;
    }

    await clients.index.deleteMany({
      filter: {
        entryId: { $eq: entryId },
      },
    });
  }

  async search(
    query: string,
    topK = DEFAULT_TOP_K,
  ): Promise<KnowledgeVectorMatch[]> {
    const clients = this.getClients();

    if (!clients) {
      return [];
    }

    const vector = await clients.embeddings.embedQuery(query);
    const response = await clients.index.query({
      vector,
      topK,
      includeMetadata: true,
    });

    return response.matches
      .map((match) => this.matchFromMetadata(match.metadata, match.score))
      .filter((match): match is KnowledgeVectorMatch => match !== null);
  }

  private getClients(): VectorClients | null {
    const config = this.getVectorConfig();

    if (!config) {
      return null;
    }

    const clientKey = JSON.stringify(config);

    if (this.cachedClients && this.cachedClientKey === clientKey) {
      return this.cachedClients;
    }

    const pinecone = new Pinecone({
      apiKey: config.pineconeApiKey,
    });
    const index = pinecone.index<KnowledgeVectorMetadata>({
      name: config.pineconeIndexName ?? undefined,
      host: config.pineconeIndexHost ?? undefined,
      namespace: config.namespace,
    });
    const embeddings = new OpenAIEmbeddings({
      apiKey: config.openAiApiKey,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
    });

    this.cachedClients = { index, embeddings };
    this.cachedClientKey = clientKey;

    return this.cachedClients;
  }

  private getVectorConfig(): VectorConfig | null {
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

    if (
      !openAiApiKey ||
      !pineconeApiKey ||
      (!pineconeIndexName && !pineconeIndexHost)
    ) {
      return null;
    }

    return {
      openAiApiKey,
      pineconeApiKey,
      pineconeIndexName: pineconeIndexName || null,
      pineconeIndexHost: pineconeIndexHost || null,
      namespace:
        this.configService.get<string>('PINECONE_NAMESPACE')?.trim() ||
        DEFAULT_NAMESPACE,
      embeddingModel:
        this.configService.get<string>('OPENAI_EMBEDDING_MODEL')?.trim() ||
        DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions: this.getEmbeddingDimensions(),
    };
  }

  private getEmbeddingDimensions(): number | undefined {
    const raw = this.configService
      .get<string>('OPENAI_EMBEDDING_DIMENSIONS')
      ?.trim();

    if (!raw) {
      return undefined;
    }

    const value = Number(raw);

    return Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private chunkText(text: string): string[] {
    const chunkSize = this.getPositiveIntegerConfig(
      'KNOWLEDGEBASE_CHUNK_CHARS',
      DEFAULT_CHUNK_CHARS,
    );
    const overlap = Math.min(
      this.getPositiveIntegerConfig(
        'KNOWLEDGEBASE_CHUNK_OVERLAP_CHARS',
        DEFAULT_CHUNK_OVERLAP_CHARS,
      ),
      chunkSize - 1,
    );
    const normalized = text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const chunks: string[] = [];
    let start = 0;

    while (start < normalized.length) {
      let end = Math.min(start + chunkSize, normalized.length);

      if (end < normalized.length) {
        end = this.findChunkBoundary(normalized, start, end);
      }

      const chunk = normalized.slice(start, end).trim();

      if (chunk) {
        chunks.push(chunk);
      }

      if (end >= normalized.length) {
        break;
      }

      start = Math.max(end - overlap, start + 1);
    }

    return chunks;
  }

  private findChunkBoundary(text: string, start: number, end: number): number {
    const minimumEnd = start + Math.floor((end - start) * 0.65);
    const paragraphBoundary = text.lastIndexOf('\n\n', end);

    if (paragraphBoundary >= minimumEnd) {
      return paragraphBoundary;
    }

    const sentenceBoundary = text.lastIndexOf('. ', end);

    if (sentenceBoundary >= minimumEnd) {
      return sentenceBoundary + 1;
    }

    const wordBoundary = text.lastIndexOf(' ', end);

    return wordBoundary >= minimumEnd ? wordBoundary : end;
  }

  private getPositiveIntegerConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    const value = raw ? Number(raw) : NaN;

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private matchFromMetadata(
    metadata: KnowledgeVectorMetadata | undefined,
    score: number | undefined,
  ): KnowledgeVectorMatch | null {
    if (
      !metadata ||
      typeof metadata.entryId !== 'number' ||
      typeof metadata.vectorRevision !== 'number' ||
      typeof metadata.title !== 'string' ||
      typeof metadata.text !== 'string' ||
      typeof metadata.sourceType !== 'string'
    ) {
      return null;
    }

    return {
      entryId: metadata.entryId,
      vectorRevision: metadata.vectorRevision,
      title: metadata.title,
      text: metadata.text,
      sourceType: metadata.sourceType,
      fileName: metadata.fileName || null,
      score: typeof score === 'number' ? score : null,
    };
  }

  private errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
