import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';
import type { OrderItem } from '../shopify/shopify.types';

/**
 * The lifecycle of a single abandoned cart in the recovery flow.
 *
 * - `PENDING`     — claimed for a first send, not yet confirmed (transient).
 * - `MESSAGE_SENT`— at least one reminder delivered; awaiting an outcome.
 * - `RECOVERED`   — the checkout became a paid order after we messaged.
 * - `NO_RESPONSE` — the window elapsed with no reply and no purchase.
 * - `TRANSFERRED_TO_HUMAN` — the customer replied and a human was flagged.
 */
export const REMINDER_STATUS = {
  PENDING: 'PENDING',
  MESSAGE_SENT: 'MESSAGE_SENT',
  RECOVERED: 'RECOVERED',
  NO_RESPONSE: 'NO_RESPONSE',
  TRANSFERRED_TO_HUMAN: 'TRANSFERRED_TO_HUMAN',
} as const;

export type ReminderStatus =
  (typeof REMINDER_STATUS)[keyof typeof REMINDER_STATUS];

export type ReminderRecord = {
  checkoutId: string;
  phoneNumber: string | null;
  email: string | null;
  customerName: string | null;
  items: OrderItem[];
  recoveryUrl: string | null;
  status: ReminderStatus;
  messageCount: number;
  firstMessageAt: string | null;
  secondMessageAt: string | null;
  respondedAt: string | null;
  recoveredAt: string | null;
  transferredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ReminderRow = Omit<ReminderRecord, 'items'> & { items: unknown };

/** The snapshot of the customer captured when the first reminder is sent. */
export type FirstReminderDetails = {
  phoneNumber: string;
  email: string | null;
  customerName: string | null;
  items: OrderItem[];
  recoveryUrl: string | null;
};

/**
 * Records every abandoned checkout the recovery flow touches: who was messaged,
 * what they had in the cart, when each reminder went out, and how it ended. The
 * checkout's Shopify id is the primary key, so claiming a checkout is an atomic
 * insert — two concurrent poll cycles (or two server instances) cannot both send
 * the first reminder, and the second reminder is claimed just as atomically.
 */
@Injectable()
export class AbandonedCheckoutReminderStore implements OnModuleInit {
  private readonly logger = new Logger(AbandonedCheckoutReminderStore.name);
  private readonly pool: Pool;

  constructor(poolService: PgPoolService) {
    this.pool = poolService.pool;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  /**
   * Reserves a checkout for its first send. Returns true only for the caller
   * that wins the race; a checkout already claimed or already handled yields
   * false, so the first reminder is never sent twice.
   */
  async claim(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO "AbandonedCheckoutReminder" ("checkoutId", status)
        VALUES ($1, '${REMINDER_STATUS.PENDING}')
        ON CONFLICT ("checkoutId") DO NOTHING
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /** Records the details and marks the first reminder as sent. */
  async markFirstSent(
    checkoutId: string,
    details: FirstReminderDetails,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET status = '${REMINDER_STATUS.MESSAGE_SENT}',
            "messageCount" = 1,
            "phoneNumber" = $2,
            email = $3,
            "customerName" = $4,
            items = $5::jsonb,
            "recoveryUrl" = $6,
            "firstMessageAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
      `,
      [
        checkoutId,
        details.phoneNumber,
        details.email,
        details.customerName,
        JSON.stringify(details.items ?? []),
        details.recoveryUrl,
      ],
    );
  }

  /**
   * Atomically reserves the second send. Succeeds only when the cart has had
   * exactly one message and is still awaiting an outcome, so the follow-up is
   * sent at most once even across instances.
   */
  async claimSecond(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET "messageCount" = 2,
            "secondMessageAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
          AND status = '${REMINDER_STATUS.MESSAGE_SENT}'
          AND "messageCount" = 1
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /** Undoes a second-send claim after the send failed, so it can retry later. */
  async releaseSecond(checkoutId: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET "messageCount" = 1,
            "secondMessageAt" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1 AND "messageCount" = 2
      `,
      [checkoutId],
    );
  }

  /**
   * Records that the customer replied. Returns true the first time only, so the
   * caller can act (e.g. stop the follow-up) exactly once.
   */
  async markResponded(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET "respondedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1 AND "respondedAt" IS NULL
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /** Hands the cart to a human. Terminal for the recovery flow. */
  async markTransferred(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET status = '${REMINDER_STATUS.TRANSFERRED_TO_HUMAN}',
            "transferredAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
          AND status = '${REMINDER_STATUS.MESSAGE_SENT}'
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /**
   * Marks a messaged cart as recovered once its checkout became a paid order.
   * A purchase wins over any other outcome, so this overrides NO_RESPONSE and a
   * pending follow-up alike.
   */
  async markRecovered(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET status = '${REMINDER_STATUS.RECOVERED}',
            "recoveredAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
          AND status <> '${REMINDER_STATUS.RECOVERED}'
          AND "messageCount" > 0
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /** Closes out a cart the customer never replied to and never bought. */
  async markNoResponse(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET status = '${REMINDER_STATUS.NO_RESPONSE}',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
          AND status = '${REMINDER_STATUS.MESSAGE_SENT}'
          AND "respondedAt" IS NULL
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  /**
   * Undoes a claim after the first send failed, so the next poll cycle can
   * retry. Only removes rows still PENDING; a handled row is never touched.
   */
  async release(checkoutId: string): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM "AbandonedCheckoutReminder"
        WHERE "checkoutId" = $1 AND status = '${REMINDER_STATUS.PENDING}'
      `,
      [checkoutId],
    );
  }

  async get(checkoutId: string): Promise<ReminderRecord | null> {
    const result = await this.pool.query<ReminderRow>(
      `
        SELECT * FROM "AbandonedCheckoutReminder"
        WHERE "checkoutId" = $1
      `,
      [checkoutId],
    );

    const row = result.rows[0];

    return row ? this.toRecord(row) : null;
  }

  /** All records for the dashboard, newest cart first. */
  async list(limit = 200): Promise<ReminderRecord[]> {
    const result = await this.pool.query<ReminderRow>(
      `
        SELECT * FROM "AbandonedCheckoutReminder"
        ORDER BY "createdAt" DESC
        LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: ReminderRow): ReminderRecord {
    return {
      ...row,
      items: this.parseItems(row.items),
    };
  }

  private parseItems(value: unknown): OrderItem[] {
    if (Array.isArray(value)) {
      return value as OrderItem[];
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);

        return Array.isArray(parsed) ? (parsed as OrderItem[]) : [];
      } catch {
        return [];
      }
    }

    return [];
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "AbandonedCheckoutReminder" (
        "checkoutId" TEXT PRIMARY KEY,
        "phoneNumber" TEXT,
        email TEXT,
        "customerName" TEXT,
        items JSONB,
        "recoveryUrl" TEXT,
        status TEXT NOT NULL DEFAULT '${REMINDER_STATUS.PENDING}',
        "messageCount" INTEGER NOT NULL DEFAULT 0,
        "firstMessageAt" TIMESTAMP(3),
        "secondMessageAt" TIMESTAMP(3),
        "respondedAt" TIMESTAMP(3),
        "recoveredAt" TIMESTAMP(3),
        "transferredAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Migrate an older single-message table (checkoutId/phoneNumber/recoveryUrl/
    // status/sentAt) up to the full record without losing history.
    await this.pool.query(`
      ALTER TABLE "AbandonedCheckoutReminder"
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS "customerName" TEXT,
      ADD COLUMN IF NOT EXISTS items JSONB,
      ADD COLUMN IF NOT EXISTS "messageCount" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "firstMessageAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "secondMessageAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "recoveredAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "transferredAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
    // Carry a legacy `sentAt`/`SENT` row into the new shape.
    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'AbandonedCheckoutReminder' AND column_name = 'sentAt'
        ) THEN
          UPDATE "AbandonedCheckoutReminder"
          SET "firstMessageAt" = COALESCE("firstMessageAt", "sentAt"),
              "messageCount" = GREATEST("messageCount", 1),
              status = '${REMINDER_STATUS.MESSAGE_SENT}'
          WHERE status = 'SENT';
        END IF;
      END
      $$;
    `);

    this.logger.log('Abandoned checkout reminder storage is ready');
  }
}
