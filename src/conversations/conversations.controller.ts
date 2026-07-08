import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ConversationMessageWithTimestamp,
  ConversationStoreService,
  ConversationSummary,
} from '../database/conversation-store.service';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationStore: ConversationStoreService,
  ) {}

  @Get()
  listConversations(): Promise<ConversationSummary[]> {
    return this.conversationStore.listConversations();
  }

  @Get(':phoneNumber/messages')
  async findMessages(
    @Param('phoneNumber') phoneNumber: string,
  ): Promise<ConversationMessageWithTimestamp[]> {
    const messages =
      await this.conversationStore.findAllMessages(phoneNumber);

    if (messages.length === 0) {
      throw new NotFoundException(
        `No conversation found for phone number ${phoneNumber}`,
      );
    }

    return messages;
  }
}
