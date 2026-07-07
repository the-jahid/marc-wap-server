import {
  Injectable,
  InternalServerErrorException,
  Logger,
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

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly conversations = new Map<string, BaseMessage[]>();
  private readonly processedMessageIds = new Set<string>();
  private readonly processedMessageOrder: string[] = [];
  private readonly processingMessageIds = new Set<string>();
  private chatModel?: ChatOpenAI;

  constructor(private readonly configService: ConfigService) {}

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
        this.logger.error(
          `Failed to process WhatsApp message ${message.id}`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      } finally {
        this.processingMessageIds.delete(message.id);
      }
    }

    return {
      received: true,
      messagesReceived: envelopes.length,
      messagesProcessed,
      repliesSent,
    };
  }

  private async createReply(message: WhatsappInboundMessage): Promise<string> {
    const text = message.text?.body?.trim();

    if (message.type !== 'text' || !text) {
      return 'Please send a text message. I can only respond to text right now.';
    }

    const chatModel = this.getChatModel();
    const history = this.conversations.get(message.from ?? '') ?? [];
    const messages = [
      new SystemMessage(this.getSystemPrompt()),
      ...history,
      new HumanMessage(text),
    ];

    const response = await chatModel.invoke(messages);
    const reply = this.contentToText(response.content).trim();
    const finalReply =
      reply || 'Sorry, I could not generate a reply. Please try again.';

    this.saveConversationTurn(message.from ?? '', text, finalReply);

    return finalReply;
  }

  private getChatModel(): ChatOpenAI {
    if (this.chatModel) {
      return this.chatModel;
    }

    const apiKey = this.getRequiredConfig(['OPENAI_API_KEY']);
    const model =
      this.configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-4o-mini';

    this.chatModel = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.4,
      maxRetries: 2,
    });

    return this.chatModel;
  }

  private getSystemPrompt(): string {
    return (
      this.configService.get<string>('CHATBOT_SYSTEM_PROMPT')?.trim() ||
      [
        'You are a helpful WhatsApp assistant.',
        'Keep replies concise, clear, and suitable for mobile chat.',
        'Ask a short follow-up question when you need more details.',
      ].join(' ')
    );
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

  private saveConversationTurn(
    userId: string,
    userText: string,
    assistantText: string,
  ): void {
    if (!userId) {
      return;
    }

    const history = this.conversations.get(userId) ?? [];
    history.push(new HumanMessage(userText), new AIMessage(assistantText));
    this.conversations.set(userId, history.slice(-10));
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
