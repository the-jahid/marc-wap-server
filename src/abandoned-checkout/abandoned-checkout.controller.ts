import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
} from '@nestjs/common';
import {
  AbandonedCheckoutConfigStore,
  DEFAULT_REMINDER_MESSAGE,
  type AbandonedCheckoutConfig,
} from './abandoned-checkout-config.store';
import { AbandonedCheckoutService } from './abandoned-checkout.service';
import type {
  AbandonedCheckoutRunResult,
  AbandonedCheckoutStatus,
} from './abandoned-checkout.service';

const MAX_MESSAGE_LENGTH = 1024;
const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 7 * 24 * 60;

type AbandonedCheckoutConfigInput = {
  enabled?: unknown;
  messageTemplate?: unknown;
  delayMinutes?: unknown;
};

type AbandonedCheckoutConfigResponse = AbandonedCheckoutConfig & {
  defaultMessageTemplate: string;
  infrastructureReady: boolean;
  pollMinutes: number;
  lookbackHours: number;
};

@Controller('abandoned-checkouts')
export class AbandonedCheckoutController {
  constructor(
    private readonly service: AbandonedCheckoutService,
    private readonly configStore: AbandonedCheckoutConfigStore,
  ) {}

  /** Current configuration and whether the recovery poller is running. */
  @Get('status')
  getStatus(): Promise<AbandonedCheckoutStatus> {
    return this.service.getStatus();
  }

  /** The operator-editable reminder settings, plus context for the editor. */
  @Get('config')
  async getConfig(): Promise<AbandonedCheckoutConfigResponse> {
    const [config, status] = await Promise.all([
      this.configStore.getConfig(),
      this.service.getStatus(),
    ]);

    return {
      ...config,
      defaultMessageTemplate: DEFAULT_REMINDER_MESSAGE,
      infrastructureReady: status.infrastructureReady,
      pollMinutes: status.pollMinutes,
      lookbackHours: status.lookbackHours,
    };
  }

  @Put('config')
  async updateConfig(
    @Body() body: AbandonedCheckoutConfigInput,
  ): Promise<AbandonedCheckoutConfigResponse> {
    const enabled = body.enabled === true;

    const messageTemplate =
      typeof body.messageTemplate === 'string'
        ? body.messageTemplate.trim()
        : '';

    if (enabled && !messageTemplate) {
      throw new BadRequestException(
        'A reminder message is required before enabling recovery',
      );
    }

    if (messageTemplate.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `The reminder message cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    const delayMinutes = Number(body.delayMinutes);

    if (
      !Number.isFinite(delayMinutes) ||
      !Number.isInteger(delayMinutes) ||
      delayMinutes < MIN_DELAY_MINUTES ||
      delayMinutes > MAX_DELAY_MINUTES
    ) {
      throw new BadRequestException(
        `Delay must be a whole number of minutes between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES}`,
      );
    }

    const saved = await this.configStore.updateConfig({
      enabled,
      messageTemplate: messageTemplate || DEFAULT_REMINDER_MESSAGE,
      delayMinutes,
    });
    const status = await this.service.getStatus();

    return {
      ...saved,
      defaultMessageTemplate: DEFAULT_REMINDER_MESSAGE,
      infrastructureReady: status.infrastructureReady,
      pollMinutes: status.pollMinutes,
      lookbackHours: status.lookbackHours,
    };
  }

  /**
   * Runs one recovery pass immediately. Useful for testing and for driving the
   * job from an external scheduler (e.g. a Render cron) instead of the built-in
   * interval.
   */
  @Post('run')
  @HttpCode(200)
  run(): Promise<AbandonedCheckoutRunResult> {
    return this.service.runOnce();
  }
}
