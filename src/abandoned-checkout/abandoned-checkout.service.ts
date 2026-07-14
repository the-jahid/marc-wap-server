import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationStoreService } from '../database/conversation-store.service';
import { ShopifyService } from '../shopify/shopify.service';
import type { AbandonedCheckout } from '../shopify/shopify.types';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  AbandonedCheckoutConfigStore,
  DEFAULT_DELAY_MINUTES,
  type AbandonedCheckoutConfig,
} from './abandoned-checkout-config.store';
import { AbandonedCheckoutReminderStore } from './abandoned-checkout-reminder.store';
import { renderReminderMessage } from './reminder-message';

const DEFAULT_POLL_MINUTES = 5;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_NAME_FALLBACK = 'cliente';
// WhatsApp accepts E.164 without the leading '+': 7-15 digits, no leading zero.
const WHATSAPP_PHONE_PATTERN = /^[1-9]\d{6,14}$/;

export type AbandonedCheckoutRunResult = {
  skipped: boolean;
  reason?: string;
  scanned: number;
  sent: number;
  skippedCompleted: number;
  skippedNoPhone: number;
  skippedNoRecoveryUrl: number;
  skippedAlreadySent: number;
  failed: number;
  durationMs: number;
};

export type AbandonedCheckoutStatus = {
  /** Shopify + WhatsApp credentials are present, so the poller is running. */
  infrastructureReady: boolean;
  /** The operator has switched recovery on from the dashboard. */
  enabled: boolean;
  running: boolean;
  delayMinutes: number;
  pollMinutes: number;
  lookbackHours: number;
};

/**
 * Recovers abandoned Shopify checkouts by messaging the customer on WhatsApp
 * with an operator-written text message (not an approved Meta template).
 *
 * Rather than starting a 60-minute timer per checkout (which a restart would
 * lose), this polls Shopify on an interval and acts only on checkouts that are
 * already old enough to count as abandoned. Every send is guarded by the
 * reminder store, so a customer is messaged at most once per cart.
 *
 * The conversation that follows a reminder is handled by the existing inbound
 * WhatsApp agent: when the customer replies, the webhook flow answers their
 * questions, resends the link, and flags a human when needed.
 */
@Injectable()
export class AbandonedCheckoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AbandonedCheckoutService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly shopifyService?: ShopifyService,
    @Optional() private readonly whatsappService?: WhatsappService,
    @Optional() private readonly reminderStore?: AbandonedCheckoutReminderStore,
    @Optional() private readonly configStore?: AbandonedCheckoutConfigStore,
    @Optional() private readonly conversationStore?: ConversationStoreService,
  ) {}

  onModuleInit(): void {
    // The poller only runs when the credentials it needs are present. Whether it
    // actually sends anything is decided per cycle by the operator's on/off
    // toggle, so flipping the toggle takes effect without a restart.
    if (!this.infrastructureReady()) {
      this.logger.log(
        'Abandoned checkout recovery poller is idle ' +
          '(configure Shopify Admin API + WhatsApp sending to start it)',
      );
      return;
    }

    const pollMs = this.pollMinutes() * 60_000;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.logger.error(
          'Abandoned checkout poll cycle failed',
          error instanceof Error ? error.stack : String(error),
        );
      });
    }, pollMs);

    // Do not let the reminder poll keep the process alive on shutdown.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    this.logger.log(
      `Abandoned checkout recovery poller started (every ${this.pollMinutes()}m)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async getStatus(): Promise<AbandonedCheckoutStatus> {
    const config = await this.loadConfig();

    return {
      infrastructureReady: this.infrastructureReady(),
      enabled: config.enabled,
      running: this.running,
      delayMinutes: config.delayMinutes,
      pollMinutes: this.pollMinutes(),
      lookbackHours: this.lookbackHours(),
    };
  }

  /**
   * Runs a single recovery pass. Safe to call from the interval or by hand
   * (`POST /abandoned-checkouts/run`); overlapping runs are dropped.
   */
  async runOnce(now: number = Date.now()): Promise<AbandonedCheckoutRunResult> {
    const started = Date.now();
    const empty = (
      skipped: boolean,
      reason?: string,
    ): AbandonedCheckoutRunResult => ({
      skipped,
      reason,
      scanned: 0,
      sent: 0,
      skippedCompleted: 0,
      skippedNoPhone: 0,
      skippedNoRecoveryUrl: 0,
      skippedAlreadySent: 0,
      failed: 0,
      durationMs: Date.now() - started,
    });

    if (!this.infrastructureReady()) {
      return empty(true, 'not-configured');
    }

    const config = await this.loadConfig();

    if (!config.enabled) {
      return empty(true, 'disabled');
    }

    if (this.running) {
      return empty(true, 'already-running');
    }

    this.running = true;
    let scanned = 0;
    let sent = 0;
    let skippedCompleted = 0;
    let skippedNoPhone = 0;
    let skippedNoRecoveryUrl = 0;
    let skippedAlreadySent = 0;
    let failed = 0;

    try {
      const checkouts = await this.shopifyService!.findRecentAbandonedCheckouts(
        {
          delayMs: config.delayMinutes * 60_000,
          lookbackMs: this.lookbackHours() * 3_600_000,
          now,
        },
      );

      for (const checkout of checkouts) {
        scanned += 1;

        // Step 3: never chase a checkout the customer already completed.
        if (checkout.completedAt) {
          skippedCompleted += 1;
          continue;
        }

        // Step 4: a reminder is worthless without a valid, dialable number.
        const phone = this.toSendablePhone(checkout.phone);
        if (!phone) {
          skippedNoPhone += 1;
          continue;
        }

        if (!checkout.recoveryUrl) {
          skippedNoRecoveryUrl += 1;
          continue;
        }

        // Step 5: claim atomically; a losing claim means it was already sent.
        const claimed = await this.reminderStore!.claim(checkout.id);
        if (!claimed) {
          skippedAlreadySent += 1;
          continue;
        }

        try {
          await this.sendReminder(phone, checkout, config.messageTemplate);
          await this.reminderStore!.markSent(
            checkout.id,
            phone,
            checkout.recoveryUrl,
          );
          sent += 1;
          this.logger.log(
            `Sent abandoned checkout reminder to ${this.maskPhone(phone)}`,
          );
        } catch (error) {
          failed += 1;
          // Free the claim so the next cycle can retry a transient failure.
          await this.reminderStore!.release(checkout.id).catch(() => undefined);
          this.logger.error(
            `Failed to send abandoned checkout reminder to ${this.maskPhone(phone)}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } finally {
      this.running = false;
    }

    return {
      skipped: false,
      scanned,
      sent,
      skippedCompleted,
      skippedNoPhone,
      skippedNoRecoveryUrl,
      skippedAlreadySent,
      failed,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Step 6: render the operator's message with this customer's name and cart
   * link, send it as a plain WhatsApp text, then mirror it into the conversation
   * history so the dashboard shows it and the agent has the link ready to resend
   * if the customer asks to buy.
   */
  private async sendReminder(
    phone: string,
    checkout: AbandonedCheckout,
    messageTemplate: string,
  ): Promise<void> {
    const name = checkout.customerFirstName?.trim() || this.nameFallback();
    const message = renderReminderMessage(messageTemplate, {
      name,
      link: checkout.recoveryUrl!,
    });

    await this.whatsappService!.sendManualText(phone, message);
    await this.recordReminderInConversation(phone, message);
  }

  private async recordReminderInConversation(
    phone: string,
    message: string,
  ): Promise<void> {
    if (!this.conversationStore) {
      return;
    }

    try {
      await this.conversationStore.saveMessage(phone, 'ASSISTANT', message);
    } catch (error) {
      this.logger.warn(
        `Sent reminder to ${this.maskPhone(phone)} but failed to record it in the conversation`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** True when the credentials required to poll and send are configured. */
  infrastructureReady(): boolean {
    return Boolean(
      this.shopifyService?.isConfigured() &&
      this.whatsappService?.canSendMessages() &&
      this.reminderStore &&
      this.configStore,
    );
  }

  private async loadConfig(): Promise<AbandonedCheckoutConfig> {
    if (this.configStore) {
      return this.configStore.getConfig();
    }

    return {
      enabled: false,
      messageTemplate: '',
      delayMinutes: DEFAULT_DELAY_MINUTES,
      updatedAt: null,
    };
  }

  private toSendablePhone(phone: string | null): string | null {
    if (!phone) {
      return null;
    }

    return WHATSAPP_PHONE_PATTERN.test(phone) ? phone : null;
  }

  private nameFallback(): string {
    return (
      this.configService
        .get<string>('WHATSAPP_ABANDONED_NAME_FALLBACK')
        ?.trim() || DEFAULT_NAME_FALLBACK
    );
  }

  private pollMinutes(): number {
    return this.positiveNumber(
      'ABANDONED_CHECKOUT_POLL_MINUTES',
      DEFAULT_POLL_MINUTES,
    );
  }

  private lookbackHours(): number {
    return this.positiveNumber(
      'ABANDONED_CHECKOUT_LOOKBACK_HOURS',
      DEFAULT_LOOKBACK_HOURS,
    );
  }

  private positiveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    const value = raw ? Number(raw) : NaN;

    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private maskPhone(phone: string): string {
    return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
  }
}
