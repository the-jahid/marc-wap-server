import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import type {
  WhatsappWebhookPayload,
  WhatsappWebhookResult,
} from './whatsapp.types';

@Controller('webhooks/whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    if (!this.whatsappService.isValidWebhookChallenge(mode, verifyToken)) {
      throw new ForbiddenException(
        'Invalid WhatsApp webhook verification token',
      );
    }

    return challenge ?? '';
  }

  @Post()
  @HttpCode(200)
  async receiveWebhook(
    @Body() payload: WhatsappWebhookPayload,
  ): Promise<WhatsappWebhookResult> {
    return this.whatsappService.processWebhook(payload);
  }
}
