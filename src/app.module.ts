import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AbandonedCheckoutModule } from './abandoned-checkout/abandoned-checkout.module';
import { AgentConfigModule } from './agent-config/agent-config.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DatabaseModule } from './database/database.module';
import { KnowledgebaseModule } from './knowledgebase/knowledgebase.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AgentConfigModule,
    KnowledgebaseModule,
    ConversationsModule,
    WhatsappModule,
    AbandonedCheckoutModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
