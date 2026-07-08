import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { KnowledgebaseModule } from '../knowledgebase/knowledgebase.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AgentConfigModule, KnowledgebaseModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
})
export class WhatsappModule {}
