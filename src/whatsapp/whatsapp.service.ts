import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import type {
  WhatsappInboundMessage,
  WhatsappMessageEnvelope,
  WhatsappWebhookPayload,
  WhatsappWebhookResult,
} from './whatsapp.types';
import {
  AgentConfigService,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from '../agent-config/agent-config.service';
import { CONVERSATION_STORE } from '../database/conversation-store.constants';
import type { ConversationStore } from '../database/conversation-store.service';
import { KnowledgebaseService } from '../knowledgebase/knowledgebase.service';

const MAX_CONVERSATION_TURNS = 15;
const MAX_CONVERSATION_MESSAGES = MAX_CONVERSATION_TURNS * 2;
const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const CONVERSATION_ROLE = {
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
} as const;
const execFileAsync = promisify(execFile);

type DownloadedWhatsappMedia = {
  data: Buffer;
  mimeType: string;
};

type TranscriptionAudio = DownloadedWhatsappMedia & {
  filename: string;
};

type WhatsappMediaMetadata = {
  url?: string;
  mime_type?: string;
  file_size?: number;
};

type OpenAITranscriptionResponse = {
  text?: string;
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly conversations = new Map<string, BaseMessage[]>();
  private readonly processedMessageIds = new Set<string>();
  private readonly processedMessageOrder: string[] = [];
  private readonly processingMessageIds = new Set<string>();
  private chatModel?: ChatOpenAI;
  private chatModelName?: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CONVERSATION_STORE)
    private readonly conversationStore?: ConversationStore,
    @Optional()
    private readonly agentConfigService?: AgentConfigService,
    @Optional()
    private readonly knowledgebaseService?: KnowledgebaseService,
  ) {}

  isValidWebhookChallenge(mode?: string, verifyToken?: string): boolean {
    const expectedVerifyToken = this.configService
      .get<string>('WHATSAPP_VERIFY_TOKEN')
      ?.trim();

    return (
      mode === 'subscribe' &&
      Boolean(expectedVerifyToken) &&
      verifyToken === expectedVerifyToken
    );
  }

  async processWebhook(
    payload: WhatsappWebhookPayload,
  ): Promise<WhatsappWebhookResult> {
    const envelopes = this.extractMessageEnvelopes(payload);
    let messagesProcessed = 0;
    let repliesSent = 0;
    let errors = 0;

    for (const envelope of envelopes) {
      const { message } = envelope;

      if (!message.id || !message.from) {
        continue;
      }

      if (
        this.processedMessageIds.has(message.id) ||
        this.processingMessageIds.has(message.id)
      ) {
        continue;
      }

      this.processingMessageIds.add(message.id);

      try {
        const reply = await this.createReply(message);

        await this.sendWhatsAppText(
          message.from,
          reply,
          envelope.phoneNumberId,
        );

        this.rememberProcessedMessage(message.id);
        messagesProcessed += 1;
        repliesSent += 1;
      } catch (error) {
        errors += 1;
        this.rememberProcessedMessage(message.id);
        this.logger.error(
          `Failed to process WhatsApp message ${message.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      } finally {
        this.processingMessageIds.delete(message.id);
      }
    }

    return {
      received: true,
      messagesReceived: envelopes.length,
      messagesProcessed,
      repliesSent,
      errors,
    };
  }

  private async createReply(message: WhatsappInboundMessage): Promise<string> {
    const text = await this.extractUserText(message);

    if (!text) {
      return 'Please send a text or voice message. I can respond to both now.';
    }

    const { systemPrompt, model } = await this.resolveAgentSettings();
    const chatModel = this.getChatModel(model);
    const userId = message.from ?? '';
    const history = await this.getConversationHistory(userId);
    const knowledgebaseContext = await this.buildKnowledgebaseContext(text);
    const messages = [
      new SystemMessage(`${systemPrompt}${knowledgebaseContext}`),
      ...history,
      new HumanMessage(text),
    ];

    const response = await chatModel.invoke(messages);
    const reply = this.contentToText(response.content).trim();
    const finalReply =
      reply || 'Sorry, I could not generate a reply. Please try again.';

    await this.saveConversationTurn(userId, text, finalReply);

    return finalReply;
  }

  private async extractUserText(
    message: WhatsappInboundMessage,
  ): Promise<string | null> {
    const text = message.text?.body?.trim();

    if (message.type === 'text' && text) {
      return text;
    }

    if (message.type !== 'audio') {
      return null;
    }

    const mediaId = message.audio?.id;

    if (!mediaId) {
      return null;
    }

    const media = await this.downloadWhatsappMedia(
      mediaId,
      message.audio?.mime_type,
    );
    const transcript = await this.transcribeAudio(media);

    return transcript || null;
  }

  private getChatModel(model: string): ChatOpenAI {
    if (this.chatModel && this.chatModelName === model) {
      return this.chatModel;
    }

    const apiKey = this.getRequiredConfig(['OPENAI_API_KEY']);

    this.chatModel = new ChatOpenAI({
      apiKey,
      model,
      maxRetries: 2,
    });
    this.chatModelName = model;

    return this.chatModel;
  }

  private async resolveAgentSettings(): Promise<{
    systemPrompt: string;
    model: string;
  }> {
    let storedSystemPrompt: string | undefined;
    let storedModel: string | undefined;

    if (this.agentConfigService) {
      try {
        const stored = await this.agentConfigService.getConfig();
        storedSystemPrompt = stored.systemPrompt?.trim() || undefined;
        storedModel = stored.model?.trim() || undefined;
      } catch (error) {
        this.logger.warn(
          'Failed to load stored agent config; falling back to environment',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return {
      systemPrompt:
        storedSystemPrompt ||
        this.configService.get<string>('CHATBOT_SYSTEM_PROMPT')?.trim() ||
        DEFAULT_SYSTEM_PROMPT,
      model:
        storedModel ||
        this.configService.get<string>('OPENAI_MODEL')?.trim() ||
        DEFAULT_MODEL,
    };
  }

  private async buildKnowledgebaseContext(userText: string): Promise<string> {
    if (!this.knowledgebaseService) {
      return '';
    }

    try {
      const context =
        await this.knowledgebaseService.buildContextForQuestion(userText);

      if (!context) {
        return '';
      }

      return `\n\nUse the following knowledge base excerpts to answer questions when relevant:\n\n${context}`;
    } catch (error) {
      this.logger.warn(
        'Failed to load knowledgebase; replying without it',
        error instanceof Error ? error.stack : String(error),
      );

      return '';
    }
  }

  private async sendWhatsAppText(
    to: string,
    body: string,
    phoneNumberIdFromWebhook?: string,
  ): Promise<void> {
    const accessToken = this.getRequiredConfig([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_API_KEY',
    ]);
    const phoneNumberId =
      this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim() ||
      phoneNumberIdFromWebhook;
    const graphApiVersion =
      this.configService.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() ||
      'v23.0';

    if (!phoneNumberId) {
      throw new InternalServerErrorException(
        'Missing WHATSAPP_PHONE_NUMBER_ID configuration',
      );
    }

    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body: this.limitWhatsappText(body),
          },
        }),
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      throw new InternalServerErrorException(
        `WhatsApp API reply failed with HTTP ${response.status}: ${responseBody}`,
      );
    }
  }

  private async downloadWhatsappMedia(
    mediaId: string,
    webhookMimeType?: string,
  ): Promise<DownloadedWhatsappMedia> {
    const accessToken = this.getRequiredConfig([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_API_KEY',
    ]);
    const graphApiVersion =
      this.configService.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() ||
      'v23.0';

    const metadataResponse = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!metadataResponse.ok) {
      const responseBody = await metadataResponse.text();
      throw new InternalServerErrorException(
        `WhatsApp media lookup failed with HTTP ${metadataResponse.status}: ${responseBody}`,
      );
    }

    const metadata = (await metadataResponse.json()) as WhatsappMediaMetadata;

    if (!metadata.url) {
      throw new InternalServerErrorException(
        'WhatsApp media lookup did not include a download URL',
      );
    }

    if (
      metadata.file_size &&
      metadata.file_size > MAX_TRANSCRIPTION_AUDIO_BYTES
    ) {
      throw new InternalServerErrorException(
        'WhatsApp voice message is too large to transcribe',
      );
    }

    const mediaResponse = await fetch(metadata.url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!mediaResponse.ok) {
      const responseBody = await mediaResponse.text();
      throw new InternalServerErrorException(
        `WhatsApp media download failed with HTTP ${mediaResponse.status}: ${responseBody}`,
      );
    }

    const data = Buffer.from(await mediaResponse.arrayBuffer());

    if (data.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw new InternalServerErrorException(
        'WhatsApp voice message is too large to transcribe',
      );
    }

    return {
      data,
      mimeType:
        mediaResponse.headers.get('content-type') ||
        metadata.mime_type ||
        webhookMimeType ||
        'application/octet-stream',
    };
  }

  private async transcribeAudio(
    media: DownloadedWhatsappMedia,
  ): Promise<string> {
    const audio = await this.prepareAudioForTranscription(media);
    const apiKey = this.getRequiredConfig(['OPENAI_API_KEY']);
    const model =
      this.configService.get<string>('OPENAI_TRANSCRIPTION_MODEL')?.trim() ||
      DEFAULT_TRANSCRIPTION_MODEL;
    const formData = new FormData();
    formData.set('model', model);
    formData.set(
      'file',
      new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
      audio.filename,
    );

    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      throw new InternalServerErrorException(
        `OpenAI transcription failed with HTTP ${response.status}: ${responseBody}`,
      );
    }

    const payload = (await response.json()) as OpenAITranscriptionResponse;

    return payload.text?.trim() ?? '';
  }

  private async prepareAudioForTranscription(
    media: DownloadedWhatsappMedia,
  ): Promise<TranscriptionAudio> {
    const extension = this.getSupportedTranscriptionExtension(media.mimeType);

    if (extension) {
      return {
        ...media,
        filename: `voice.${extension}`,
      };
    }

    return this.convertAudioToWav(media);
  }

  private async convertAudioToWav(
    media: DownloadedWhatsappMedia,
  ): Promise<TranscriptionAudio> {
    if (!ffmpegPath) {
      throw new InternalServerErrorException(
        'FFmpeg is unavailable; cannot convert WhatsApp voice message audio',
      );
    }

    const tempDirectory = await mkdtemp(join(tmpdir(), 'whatsapp-voice-'));
    const inputPath = join(
      tempDirectory,
      `input.${this.getAudioExtension(media.mimeType)}`,
    );
    const outputPath = join(tempDirectory, 'voice.wav');

    try {
      await writeFile(inputPath, media.data);
      await execFileAsync(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        outputPath,
      ]);

      const data = await readFile(outputPath);

      if (data.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
        throw new InternalServerErrorException(
          'Converted WhatsApp voice message is too large to transcribe',
        );
      }

      return {
        data,
        mimeType: 'audio/wav',
        filename: 'voice.wav',
      };
    } finally {
      await rm(tempDirectory, { force: true, recursive: true });
    }
  }

  private getSupportedTranscriptionExtension(mimeType: string): string | null {
    const normalizedMimeType = mimeType.toLowerCase();

    if (normalizedMimeType.includes('mpeg')) {
      return 'mp3';
    }

    if (normalizedMimeType.includes('mp4')) {
      return 'mp4';
    }

    if (normalizedMimeType.includes('m4a')) {
      return 'm4a';
    }

    if (normalizedMimeType.includes('wav')) {
      return 'wav';
    }

    if (normalizedMimeType.includes('webm')) {
      return 'webm';
    }

    return null;
  }

  private getAudioExtension(mimeType: string): string {
    const normalizedMimeType = mimeType.toLowerCase();

    if (normalizedMimeType.includes('ogg')) {
      return 'ogg';
    }

    if (normalizedMimeType.includes('opus')) {
      return 'opus';
    }

    return 'audio';
  }

  private extractMessageEnvelopes(
    payload: WhatsappWebhookPayload,
  ): WhatsappMessageEnvelope[] {
    const envelopes: WhatsappMessageEnvelope[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        const phoneNumberId = change.value?.metadata?.phone_number_id;

        for (const message of messages) {
          envelopes.push({ message, phoneNumberId });
        }
      }
    }

    return envelopes;
  }

  private async getConversationHistory(userId: string): Promise<BaseMessage[]> {
    if (!userId) {
      return [];
    }

    if (!this.conversationStore) {
      return this.conversations.get(userId) ?? [];
    }

    try {
      const history = await this.conversationStore.findLatestMessages(
        userId,
        MAX_CONVERSATION_MESSAGES,
      );

      return history.map((message) => {
        return message.role === CONVERSATION_ROLE.USER
          ? new HumanMessage(message.content)
          : new AIMessage(message.content);
      });
    } catch (error) {
      this.logger.warn(
        `Failed to load conversation history for ${userId}; using in-memory history`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.conversations.get(userId) ?? [];
    }
  }

  private async saveConversationTurn(
    userId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    if (!userId) {
      return;
    }

    this.saveConversationTurnInMemory(userId, userText, assistantText);

    if (!this.conversationStore) {
      return;
    }

    try {
      await this.conversationStore.saveTurn(
        userId,
        userText,
        assistantText,
        MAX_CONVERSATION_MESSAGES,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to save conversation history for ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private saveConversationTurnInMemory(
    userId: string,
    userText: string,
    assistantText: string,
  ): void {
    const history = this.conversations.get(userId) ?? [];
    history.push(new HumanMessage(userText), new AIMessage(assistantText));
    this.conversations.set(userId, history.slice(-MAX_CONVERSATION_MESSAGES));
  }

  private rememberProcessedMessage(messageId: string): void {
    this.processedMessageIds.add(messageId);
    this.processedMessageOrder.push(messageId);

    while (this.processedMessageOrder.length > 500) {
      const oldestMessageId = this.processedMessageOrder.shift();

      if (oldestMessageId) {
        this.processedMessageIds.delete(oldestMessageId);
      }
    }
  }

  private getRequiredConfig(keys: string[]): string {
    for (const key of keys) {
      const value = this.configService.get<string>(key)?.trim();

      if (value) {
        return value;
      }
    }

    throw new InternalServerErrorException(
      `Missing required configuration: ${keys.join(' or ')}`,
    );
  }

  private contentToText(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part.type === 'text' && 'text' in part) {
          return String(part.text);
        }

        return '';
      })
      .join('')
      .trim();
  }

  private limitWhatsappText(text: string): string {
    return text.length <= 4096 ? text : `${text.slice(0, 4093)}...`;
  }
}
