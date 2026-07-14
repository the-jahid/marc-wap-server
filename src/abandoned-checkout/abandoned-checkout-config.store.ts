import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';

/**
 * The `{{name}}` and `{{link}}` placeholders are filled in per customer before
 * the reminder is sent: the customer's first name and the Shopify cart recovery
 * link. If the message omits `{{link}}`, the link is appended so the cart URL is
 * never dropped.
 */
export const DEFAULT_REMINDER_MESSAGE =
  '¡Hola {{name}}! 👋 Vimos que dejaste algunos artículos en tu carrito. ' +
  'Termina tu compra aquí: {{link}}';

/**
 * The optional follow-up, sent roughly a day later to a customer who has neither
 * bought nor replied. Deliberately worded as a gentle nudge, not a repeat.
 */
export const DEFAULT_SECOND_REMINDER_MESSAGE =
  '¡Hola {{name}}! 👋 ¿Aún quieres completar tu compra? Guardamos tu carrito ' +
  'por si acaso: {{link}}';

export const DEFAULT_DELAY_MINUTES = 60;
/** The follow-up fires ~a day later; kept inside the spec's 20–24h window. */
export const DEFAULT_SECOND_DELAY_HOURS = 22;

export type AbandonedCheckoutConfig = {
  enabled: boolean;
  messageTemplate: string;
  delayMinutes: number;
  secondReminderEnabled: boolean;
  secondMessageTemplate: string;
  secondDelayHours: number;
  updatedAt: string | null;
};

type AbandonedCheckoutConfigRow = {
  enabled: boolean;
  messageTemplate: string | null;
  delayMinutes: number | null;
  secondReminderEnabled: boolean | null;
  secondMessageTemplate: string | null;
  secondDelayHours: number | null;
  updatedAt: string | null;
};

/**
 * Stores the operator-editable settings for abandoned-checkout recovery in a
 * single row (like AgentConfig), so the reminder wording, the wait times, the
 * follow-up and whether the feature is on can all be changed from the dashboard
 * without a redeploy. These are plain WhatsApp text messages the operator
 * writes — not approved Meta templates.
 */
@Injectable()
export class AbandonedCheckoutConfigStore implements OnModuleInit {
  private readonly logger = new Logger(AbandonedCheckoutConfigStore.name);
  private readonly pool: Pool;

  constructor(poolService: PgPoolService) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "AbandonedCheckoutConfig" (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        "messageTemplate" TEXT,
        "delayMinutes" INTEGER NOT NULL DEFAULT ${DEFAULT_DELAY_MINUTES},
        "secondReminderEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
        "secondMessageTemplate" TEXT,
        "secondDelayHours" INTEGER NOT NULL DEFAULT ${DEFAULT_SECOND_DELAY_HOURS},
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Bring an older single-message config table up to date without a redeploy.
    await this.pool.query(`
      ALTER TABLE "AbandonedCheckoutConfig"
      ADD COLUMN IF NOT EXISTS "secondReminderEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS "secondMessageTemplate" TEXT,
      ADD COLUMN IF NOT EXISTS "secondDelayHours" INTEGER NOT NULL DEFAULT ${DEFAULT_SECOND_DELAY_HOURS};
    `);

    this.logger.log('Abandoned checkout config storage is ready');
  }

  async getConfig(): Promise<AbandonedCheckoutConfig> {
    const result = await this.pool.query<AbandonedCheckoutConfigRow>(`
      SELECT
        enabled,
        "messageTemplate",
        "delayMinutes",
        "secondReminderEnabled",
        "secondMessageTemplate",
        "secondDelayHours",
        "updatedAt"
      FROM "AbandonedCheckoutConfig"
      WHERE id = 1
    `);

    return this.toConfig(result.rows[0]);
  }

  async updateConfig(input: {
    enabled: boolean;
    messageTemplate: string;
    delayMinutes: number;
    secondReminderEnabled: boolean;
    secondMessageTemplate: string;
    secondDelayHours: number;
  }): Promise<AbandonedCheckoutConfig> {
    const result = await this.pool.query<AbandonedCheckoutConfigRow>(
      `
        INSERT INTO "AbandonedCheckoutConfig" (
          id,
          enabled,
          "messageTemplate",
          "delayMinutes",
          "secondReminderEnabled",
          "secondMessageTemplate",
          "secondDelayHours"
        )
        VALUES (1, $1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE
        SET enabled = $1,
            "messageTemplate" = $2,
            "delayMinutes" = $3,
            "secondReminderEnabled" = $4,
            "secondMessageTemplate" = $5,
            "secondDelayHours" = $6,
            "updatedAt" = CURRENT_TIMESTAMP
        RETURNING
          enabled,
          "messageTemplate",
          "delayMinutes",
          "secondReminderEnabled",
          "secondMessageTemplate",
          "secondDelayHours",
          "updatedAt"
      `,
      [
        input.enabled,
        input.messageTemplate,
        input.delayMinutes,
        input.secondReminderEnabled,
        input.secondMessageTemplate,
        input.secondDelayHours,
      ],
    );

    return this.toConfig(result.rows[0]);
  }

  private toConfig(
    row: AbandonedCheckoutConfigRow | undefined,
  ): AbandonedCheckoutConfig {
    return {
      enabled: row?.enabled ?? false,
      messageTemplate: row?.messageTemplate?.trim() || DEFAULT_REMINDER_MESSAGE,
      delayMinutes: row?.delayMinutes ?? DEFAULT_DELAY_MINUTES,
      secondReminderEnabled: row?.secondReminderEnabled ?? true,
      secondMessageTemplate:
        row?.secondMessageTemplate?.trim() || DEFAULT_SECOND_REMINDER_MESSAGE,
      secondDelayHours: row?.secondDelayHours ?? DEFAULT_SECOND_DELAY_HOURS,
      updatedAt: row?.updatedAt ?? null,
    };
  }
}
