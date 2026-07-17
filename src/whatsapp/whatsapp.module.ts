import { Module } from '@nestjs/common';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { ShopifyModule } from '../shopify/shopify.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AgentConfigModule, ShopifyModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
