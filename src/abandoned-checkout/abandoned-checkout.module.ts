import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AbandonedCheckoutController } from './abandoned-checkout.controller';
import { AbandonedCheckoutConfigStore } from './abandoned-checkout-config.store';
import { AbandonedCheckoutReminderStore } from './abandoned-checkout-reminder.store';
import { AbandonedCheckoutService } from './abandoned-checkout.service';

@Module({
  imports: [ShopifyModule, WhatsappModule],
  controllers: [AbandonedCheckoutController],
  providers: [
    AbandonedCheckoutService,
    AbandonedCheckoutReminderStore,
    AbandonedCheckoutConfigStore,
  ],
  exports: [AbandonedCheckoutService],
})
export class AbandonedCheckoutModule {}
