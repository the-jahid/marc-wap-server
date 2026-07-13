import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ShopifyService } from './shopify.service';

@Module({
  imports: [ConfigModule],
  providers: [ShopifyService],
  exports: [ShopifyService],
})
export class ShopifyModule {}
