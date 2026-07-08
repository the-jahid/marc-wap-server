import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
