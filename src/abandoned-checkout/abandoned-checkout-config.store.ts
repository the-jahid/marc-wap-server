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

export const DEFAULT_DELAY_MINUTES = 60;

export type AbandonedCheckoutConfig = {
  enabled: boolean;
  messageTemplate: string;
  delayMinutes: number;
  updatedAt: string | null;
};

type AbandonedCheckoutConfigRow = {
  enabled: boolean;
  messageTemplate: string | null;
  delayMinutes: number | null;
  updatedAt: string | null;
};

/**
 * Stores the operator-editable settings for abandoned-checkout recovery in a
 * single row (like AgentConfig), so the reminder wording, the wait time, and
 * whether the feature is on can all be changed from the dashboard without a
 * redeploy. This is a plain WhatsApp text message the operator writes — not an
 * approved Meta template.
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
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.logger.log('Abandoned checkout config storage is ready');
  }

  async getConfig(): Promise<AbandonedCheckoutConfig> {
    const result = await this.pool.query<AbandonedCheckoutConfigRow>(`
      SELECT enabled, "messageTemplate", "delayMinutes", "updatedAt"
      FROM "AbandonedCheckoutConfig"
      WHERE id = 1
    `);

    const row = result.rows[0];

    return {
      enabled: row?.enabled ?? false,
      messageTemplate: row?.messageTemplate?.trim() || DEFAULT_REMINDER_MESSAGE,
      delayMinutes: row?.delayMinutes ?? DEFAULT_DELAY_MINUTES,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  async updateConfig(input: {
    enabled: boolean;
    messageTemplate: string;
    delayMinutes: number;
  }): Promise<AbandonedCheckoutConfig> {
    const result = await this.pool.query<AbandonedCheckoutConfigRow>(
      `
        INSERT INTO "AbandonedCheckoutConfig" (id, enabled, "messageTemplate", "delayMinutes")
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE
        SET enabled = $1,
            "messageTemplate" = $2,
            "delayMinutes" = $3,
            "updatedAt" = CURRENT_TIMESTAMP
        RETURNING enabled, "messageTemplate", "delayMinutes", "updatedAt"
      `,
      [input.enabled, input.messageTemplate, input.delayMinutes],
    );

    const row = result.rows[0];

    return {
      enabled: row.enabled,
      messageTemplate: row.messageTemplate?.trim() || DEFAULT_REMINDER_MESSAGE,
      delayMinutes: row.delayMinutes ?? DEFAULT_DELAY_MINUTES,
      updatedAt: row.updatedAt,
    };
  }
}
