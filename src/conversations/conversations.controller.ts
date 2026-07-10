import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ConversationMessageWithTimestamp,
  ConversationStoreService,
  ConversationSummary,
} from '../database/conversation-store.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

const MAX_WHATSAPP_TEXT_LENGTH = 4096;

type SendConversationMessageBody = {
  message?: unknown;
};

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationStore: ConversationStoreService,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Get()
  listConversations(): Promise<ConversationSummary[]> {
    return this.conversationStore.listConversations();
  }

  @Get(':phoneNumber/messages')
  async findMessages(
    @Param('phoneNumber') phoneNumber: string,
  ): Promise<ConversationMessageWithTimestamp[]> {
    const messages = await this.conversationStore.findAllMessages(phoneNumber);

    if (messages.length === 0) {
      throw new NotFoundException(
        `No conversation found for phone number ${phoneNumber}`,
      );
    }

    return messages;
  }

  @Post(':phoneNumber/messages')
  async sendMessage(
    @Param('phoneNumber') phoneNumber: string,
    @Body() payload: SendConversationMessageBody,
  ): Promise<ConversationMessageWithTimestamp> {
    const normalizedPhoneNumber = phoneNumber.replace(/^\+/, '');
    const message =
      typeof payload?.message === 'string' ? payload.message.trim() : '';

    if (!/^[1-9]\d{6,14}$/.test(normalizedPhoneNumber)) {
      throw new BadRequestException(
        'Phone number must contain 7 to 15 digits, including the country code',
      );
    }

    if (!message) {
      throw new BadRequestException('Message is required');
    }

    if (message.length > MAX_WHATSAPP_TEXT_LENGTH) {
      throw new BadRequestException(
        `Message cannot exceed ${MAX_WHATSAPP_TEXT_LENGTH} characters`,
      );
    }

    await this.whatsappService.sendManualText(normalizedPhoneNumber, message);

    return this.conversationStore.saveMessage(
      normalizedPhoneNumber,
      'ASSISTANT',
      message,
    );
  }
}
