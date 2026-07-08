import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
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
const MAX_KNOWLEDGEBASE_CONTEXT_CHARS = 24_000;
const CONVERSATION_ROLE = {
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
} as const;

type StoredConversationMessage = {
  id: number;
  role: keyof typeof CONVERSATION_ROLE;
  content: string;
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
    const text = message.text?.body?.trim();

    if (message.type !== 'text' || !text) {
      return 'Please send a text message. I can only respond to text right now.';
    }

    const { systemPrompt, model } = await this.resolveAgentSettings();
    const chatModel = this.getChatModel(model);
    const userId = message.from ?? '';
    const history = await this.getConversationHistory(userId);
    const knowledgebaseContext = await this.buildKnowledgebaseContext();
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

  private async buildKnowledgebaseContext(): Promise<string> {
    if (!this.knowledgebaseService) {
      return '';
    }

    try {
      const entries = await this.knowledgebaseService.list();

      if (entries.length === 0) {
        return '';
      }

      const sections = entries
        .map((entry) => `### ${entry.title}\n${entry.content}`)
        .join('\n\n');

      return `\n\nUse the following knowledge base to answer questions when relevant:\n\n${sections}`.slice(
        0,
        MAX_KNOWLEDGEBASE_CONTEXT_CHARS,
      );
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
