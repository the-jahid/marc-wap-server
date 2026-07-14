import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  AbandonedCheckoutConfigStore,
  DEFAULT_REMINDER_MESSAGE,
  DEFAULT_SECOND_REMINDER_MESSAGE,
  type AbandonedCheckoutConfig,
} from './abandoned-checkout-config.store';
import {
  AbandonedCheckoutReminderStore,
  type ReminderRecord,
} from './abandoned-checkout-reminder.store';
import { AbandonedCheckoutService } from './abandoned-checkout.service';
import type {
  AbandonedCheckoutRunResult,
  AbandonedCheckoutStatus,
} from './abandoned-checkout.service';

const MAX_MESSAGE_LENGTH = 1024;
const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 7 * 24 * 60;
const MIN_SECOND_DELAY_HOURS = 1;
const MAX_SECOND_DELAY_HOURS = 7 * 24;
const MAX_RECORDS = 500;

type AbandonedCheckoutConfigInput = {
  enabled?: unknown;
  messageTemplate?: unknown;
  delayMinutes?: unknown;
  secondReminderEnabled?: unknown;
  secondMessageTemplate?: unknown;
  secondDelayHours?: unknown;
};

type AbandonedCheckoutConfigResponse = AbandonedCheckoutConfig & {
  defaultMessageTemplate: string;
  defaultSecondMessageTemplate: string;
  infrastructureReady: boolean;
  pollMinutes: number;
  lookbackHours: number;
};

@Controller('abandoned-checkouts')
export class AbandonedCheckoutController {
  constructor(
    private readonly service: AbandonedCheckoutService,
    private readonly configStore: AbandonedCheckoutConfigStore,
    private readonly reminderStore: AbandonedCheckoutReminderStore,
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

    return this.toConfigResponse(config, status);
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

    this.assertMessageLength(messageTemplate, 'reminder message');

    const delayMinutes = this.parseInteger(
      body.delayMinutes,
      MIN_DELAY_MINUTES,
      MAX_DELAY_MINUTES,
      `Delay must be a whole number of minutes between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES}`,
    );

    const secondReminderEnabled = body.secondReminderEnabled === true;

    const secondMessageTemplate =
      typeof body.secondMessageTemplate === 'string'
        ? body.secondMessageTemplate.trim()
        : '';

    if (enabled && secondReminderEnabled && !secondMessageTemplate) {
      throw new BadRequestException(
        'A second reminder message is required when the follow-up is enabled',
      );
    }

    this.assertMessageLength(secondMessageTemplate, 'second reminder message');

    const secondDelayHours = this.parseInteger(
      body.secondDelayHours,
      MIN_SECOND_DELAY_HOURS,
      MAX_SECOND_DELAY_HOURS,
      `The follow-up delay must be a whole number of hours between ${MIN_SECOND_DELAY_HOURS} and ${MAX_SECOND_DELAY_HOURS}`,
    );

    const saved = await this.configStore.updateConfig({
      enabled,
      messageTemplate: messageTemplate || DEFAULT_REMINDER_MESSAGE,
      delayMinutes,
      secondReminderEnabled,
      secondMessageTemplate:
        secondMessageTemplate || DEFAULT_SECOND_REMINDER_MESSAGE,
      secondDelayHours,
    });
    const status = await this.service.getStatus();

    return this.toConfigResponse(saved, status);
  }

  /**
   * The recorded database of every cart the flow has touched: contact details,
   * abandoned items, the recovery link, when each reminder was sent, and the
   * current status. Powers the dashboard's recovery table.
   */
  @Get('records')
  listRecords(@Query('limit') limit?: string): Promise<ReminderRecord[]> {
    const parsed = Number(limit);
    const size =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), MAX_RECORDS)
        : 200;

    return this.reminderStore.list(size);
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

  private toConfigResponse(
    config: AbandonedCheckoutConfig,
    status: AbandonedCheckoutStatus,
  ): AbandonedCheckoutConfigResponse {
    return {
      ...config,
      defaultMessageTemplate: DEFAULT_REMINDER_MESSAGE,
      defaultSecondMessageTemplate: DEFAULT_SECOND_REMINDER_MESSAGE,
      infrastructureReady: status.infrastructureReady,
      pollMinutes: status.pollMinutes,
      lookbackHours: status.lookbackHours,
    };
  }

  private assertMessageLength(message: string, label: string): void {
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `The ${label} cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
  }

  private parseInteger(
    value: unknown,
    min: number,
    max: number,
    message: string,
  ): number {
    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < min ||
      parsed > max
    ) {
      throw new BadRequestException(message);
    }

    return parsed;
  }
}
