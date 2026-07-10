import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ConversationsController } from './conversations.controller';

@Module({
  imports: [WhatsappModule],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
