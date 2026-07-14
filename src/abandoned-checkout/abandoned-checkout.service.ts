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
  DEFAULT_SECOND_DELAY_HOURS,
  DEFAULT_SECOND_REMINDER_MESSAGE,
  type AbandonedCheckoutConfig,
} from './abandoned-checkout-config.store';
import {
  AbandonedCheckoutReminderStore,
  REMINDER_STATUS,
  type ReminderRecord,
} from './abandoned-checkout-reminder.store';
import { renderReminderMessage } from './reminder-message';

const DEFAULT_POLL_MINUTES = 5;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_NAME_FALLBACK = 'cliente';
const HOUR_MS = 3_600_000;
/**
 * After the follow-up has had a fair chance to land, a still-silent cart is
 * closed as "no response". Kept a few hours past the second reminder so the
 * customer has time to reply to it before we give up.
 */
const NO_RESPONSE_GRACE_MS = 3 * HOUR_MS;
/** A little slack on the Shopify scan window so carts stay visible until closed. */
const LOOKBACK_BUFFER_MS = 2 * HOUR_MS;
// WhatsApp accepts E.164 without the leading '+': 7-15 digits, no leading zero.
const WHATSAPP_PHONE_PATTERN = /^[1-9]\d{6,14}$/;

export type AbandonedCheckoutRunResult = {
  skipped: boolean;
  reason?: string;
  scanned: number;
  sent: number;
  secondSent: number;
  recovered: number;
  responded: number;
  transferred: number;
  noResponse: number;
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
  secondReminderEnabled: boolean;
  secondDelayHours: number;
  pollMinutes: number;
  lookbackHours: number;
};

/**
 * Recovers abandoned Shopify checkouts by messaging the customer on WhatsApp
 * with operator-written text messages (not approved Meta templates).
 *
 * Rather than starting timers per checkout (which a restart would lose), this
 * polls Shopify on an interval and drives every cart through its lifecycle in a
 * single pass:
 *   1. ~60 min after abandonment, send the first reminder.
 *   2. ~a day later, if the customer neither bought nor replied, send an
 *      optional second reminder (never more than two messages per cart).
 *   3. The moment the cart becomes a paid order, mark it recovered and stop.
 *   4. If the customer replies, the existing inbound WhatsApp agent takes over;
 *      we record the reply, and a hand-off to a human if one is flagged.
 *   5. Otherwise, once the window closes, mark the cart as no-response.
 *
 * Because the second reminder and the no-response close-out are only ever driven
 * from carts Shopify currently reports as abandoned, a customer who already
 * completed their order is never chased.
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
      secondReminderEnabled: config.secondReminderEnabled,
      secondDelayHours: config.secondDelayHours,
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
    const result: AbandonedCheckoutRunResult = {
      skipped: false,
      scanned: 0,
      sent: 0,
      secondSent: 0,
      recovered: 0,
      responded: 0,
      transferred: 0,
      noResponse: 0,
      skippedCompleted: 0,
      skippedNoPhone: 0,
      skippedNoRecoveryUrl: 0,
      skippedAlreadySent: 0,
      failed: 0,
      durationMs: 0,
    };
    const skip = (reason: string): AbandonedCheckoutRunResult => ({
      ...result,
      skipped: true,
      reason,
      durationMs: Date.now() - started,
    });

    if (!this.infrastructureReady()) {
      return skip('not-configured');
    }

    const config = await this.loadConfig();

    if (!config.enabled) {
      return skip('disabled');
    }

    if (this.running) {
      return skip('already-running');
    }

    this.running = true;

    try {
      const secondDelayMs = config.secondReminderEnabled
        ? config.secondDelayHours * HOUR_MS
        : Number.POSITIVE_INFINITY;
      const noResponseAfterMs =
        (config.secondReminderEnabled
          ? config.secondDelayHours * HOUR_MS
          : DEFAULT_LOOKBACK_HOURS * HOUR_MS) + NO_RESPONSE_GRACE_MS;
      // Keep scanning a cart until after it would be closed as no-response, so
      // both the follow-up and the close-out are decided while Shopify still
      // reports it (and still tells us if it turned into a paid order).
      const lookbackMs =
        Math.max(this.lookbackHours() * HOUR_MS, noResponseAfterMs) +
        LOOKBACK_BUFFER_MS;

      const checkouts = await this.shopifyService!.findRecentAbandonedCheckouts({
        delayMs: config.delayMinutes * 60_000,
        lookbackMs,
        now,
      });

      for (const checkout of checkouts) {
        result.scanned += 1;
        await this.processCheckout(checkout, config, {
          now,
          secondDelayMs,
          noResponseAfterMs,
          result,
        });
      }
    } finally {
      this.running = false;
    }

    result.durationMs = Date.now() - started;
    return result;
  }

  private async processCheckout(
    checkout: AbandonedCheckout,
    config: AbandonedCheckoutConfig,
    ctx: {
      now: number;
      secondDelayMs: number;
      noResponseAfterMs: number;
      result: AbandonedCheckoutRunResult;
    },
  ): Promise<void> {
    const { result } = ctx;

    // The order got completed: a purchase ends the flow. Marking only counts
    // for carts we actually messaged; a cart completed before we ever wrote is
    // simply left alone.
    if (checkout.completedAt) {
      if (await this.reminderStore!.markRecovered(checkout.id)) {
        result.recovered += 1;
      } else {
        result.skippedCompleted += 1;
      }
      return;
    }

    const phone = this.toSendablePhone(checkout.phone);
    if (!phone) {
      result.skippedNoPhone += 1;
      return;
    }

    if (!checkout.recoveryUrl) {
      result.skippedNoRecoveryUrl += 1;
      return;
    }

    const record = await this.reminderStore!.get(checkout.id);

    if (!record) {
      await this.sendFirstReminder(phone, checkout, config, result);
      return;
    }

    // Terminal states (recovered / no-response / transferred) are left as they
    // are; only a cart still awaiting an outcome is worked further.
    if (record.status !== REMINDER_STATUS.MESSAGE_SENT) {
      return;
    }

    if (await this.handleEngagement(record, phone, result)) {
      return;
    }

    await this.handleFollowUp(record, phone, checkout, config, ctx);
  }

  /**
   * Step 1: claim the cart atomically, render the operator's first message with
   * this customer's name and link, send it, and store the full record.
   */
  private async sendFirstReminder(
    phone: string,
    checkout: AbandonedCheckout,
    config: AbandonedCheckoutConfig,
    result: AbandonedCheckoutRunResult,
  ): Promise<void> {
    const claimed = await this.reminderStore!.claim(checkout.id);
    if (!claimed) {
      // Lost the race to another cycle/instance; it is being handled there.
      result.skippedAlreadySent += 1;
      return;
    }

    try {
      const message = this.renderFor(checkout, config.messageTemplate);
      await this.whatsappService!.sendManualText(phone, message);
      await this.reminderStore!.markFirstSent(checkout.id, {
        phoneNumber: phone,
        email: checkout.email,
        customerName: checkout.customerFirstName,
        items: checkout.items,
        recoveryUrl: checkout.recoveryUrl,
      });
      await this.recordReminderInConversation(phone, message);
      result.sent += 1;
      this.logger.log(
        `Sent abandoned checkout reminder to ${this.maskPhone(phone)}`,
      );
    } catch (error) {
      result.failed += 1;
      // Free the claim so the next cycle can retry a transient failure.
      await this.reminderStore!.release(checkout.id).catch(() => undefined);
      this.logger.error(
        `Failed to send abandoned checkout reminder to ${this.maskPhone(phone)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Steps 4: has the customer engaged since the reminder? If they replied, the
   * inbound WhatsApp agent is already handling them, so we record the reply
   * (which stops the follow-up) and hand off to a human when one was flagged.
   * Returns true when the cart should not be chased any further this pass.
   */
  private async handleEngagement(
    record: ReminderRecord,
    phone: string,
    result: AbandonedCheckoutRunResult,
  ): Promise<boolean> {
    if (!this.conversationStore || !record.firstMessageAt) {
      return false;
    }

    const engagement = await this.conversationStore.getEngagementSince(
      phone,
      record.firstMessageAt,
    );

    if (engagement.inboundCount === 0) {
      return false;
    }

    if (!record.respondedAt && (await this.reminderStore!.markResponded(record.checkoutId))) {
      result.responded += 1;
    }

    if (
      engagement.needsHumanAttention &&
      (await this.reminderStore!.markTransferred(record.checkoutId))
    ) {
      result.transferred += 1;
      this.logger.log(
        `Abandoned checkout for ${this.maskPhone(phone)} transferred to a human`,
      );
    }

    // The customer is talking to us; stop the automated reminders.
    return true;
  }

  /**
   * Steps 2 & 5: with no reply yet, either send the optional second reminder
   * once its delay has passed, or — after the window closes — record the cart
   * as no-response.
   */
  private async handleFollowUp(
    record: ReminderRecord,
    phone: string,
    checkout: AbandonedCheckout,
    config: AbandonedCheckoutConfig,
    ctx: {
      now: number;
      secondDelayMs: number;
      noResponseAfterMs: number;
      result: AbandonedCheckoutRunResult;
    },
  ): Promise<void> {
    const { now, secondDelayMs, noResponseAfterMs, result } = ctx;
    const ageMs = this.ageSince(record.firstMessageAt, now);

    if (
      config.secondReminderEnabled &&
      record.messageCount < 2 &&
      ageMs >= secondDelayMs
    ) {
      await this.sendSecondReminder(record, phone, checkout, config, result);
      return;
    }

    if (ageMs >= noResponseAfterMs && (await this.reminderStore!.markNoResponse(record.checkoutId))) {
      result.noResponse += 1;
    }
  }

  private async sendSecondReminder(
    record: ReminderRecord,
    phone: string,
    checkout: AbandonedCheckout,
    config: AbandonedCheckoutConfig,
    result: AbandonedCheckoutRunResult,
  ): Promise<void> {
    // Claim the follow-up before sending so it goes out at most once.
    const claimed = await this.reminderStore!.claimSecond(record.checkoutId);
    if (!claimed) {
      return;
    }

    try {
      const template =
        config.secondMessageTemplate?.trim() || DEFAULT_SECOND_REMINDER_MESSAGE;
      const message = this.renderFor(checkout, template);
      await this.whatsappService!.sendManualText(phone, message);
      await this.recordReminderInConversation(phone, message);
      result.secondSent += 1;
      this.logger.log(
        `Sent second abandoned checkout reminder to ${this.maskPhone(phone)}`,
      );
    } catch (error) {
      result.failed += 1;
      await this.reminderStore!.releaseSecond(record.checkoutId).catch(
        () => undefined,
      );
      this.logger.error(
        `Failed to send second abandoned checkout reminder to ${this.maskPhone(phone)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private renderFor(checkout: AbandonedCheckout, template: string): string {
    const name = checkout.customerFirstName?.trim() || this.nameFallback();

    return renderReminderMessage(template, {
      name,
      link: checkout.recoveryUrl!,
    });
  }

  /**
   * Mirrors a sent reminder into the conversation history so the dashboard shows
   * it and the agent has the recovery link ready to resend if the customer asks
   * to buy.
   */
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
      secondReminderEnabled: false,
      secondMessageTemplate: DEFAULT_SECOND_REMINDER_MESSAGE,
      secondDelayHours: DEFAULT_SECOND_DELAY_HOURS,
      updatedAt: null,
    };
  }

  private ageSince(timestamp: string | null, now: number): number {
    if (!timestamp) {
      return 0;
    }

    // Assumes the DB session and this process share a timezone (both UTC in
    // production), which is the same assumption the rest of the app makes.
    const then = new Date(timestamp).getTime();

    return Number.isFinite(then) ? now - then : 0;
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
