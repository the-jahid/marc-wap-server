import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PgPoolService } from '../database/pg-pool.service';

/**
 * Records which abandoned checkouts have already had a WhatsApp reminder sent,
 * so a customer is never messaged twice about the same cart. The checkout's
 * Shopify id is the primary key, which makes claiming a checkout an atomic
 * insert: two concurrent poll cycles (or two server instances) cannot both send.
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
   * Reserves a checkout for sending. Returns true only for the caller that wins
   * the race; a checkout already claimed (PENDING) or already sent (SENT) yields
   * false, so the reminder is not sent again.
   */
  async claim(checkoutId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO "AbandonedCheckoutReminder" ("checkoutId", status)
        VALUES ($1, 'PENDING')
        ON CONFLICT ("checkoutId") DO NOTHING
        RETURNING "checkoutId"
      `,
      [checkoutId],
    );

    return result.rowCount === 1;
  }

  async markSent(
    checkoutId: string,
    phoneNumber: string,
    recoveryUrl: string | null,
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE "AbandonedCheckoutReminder"
        SET status = 'SENT',
            "phoneNumber" = $2,
            "recoveryUrl" = $3,
            "sentAt" = CURRENT_TIMESTAMP
        WHERE "checkoutId" = $1
      `,
      [checkoutId, phoneNumber, recoveryUrl],
    );
  }

  /**
   * Undoes a claim after a send failed, so the next poll cycle can retry. Only
   * removes rows still PENDING; a SENT row is never touched.
   */
  async release(checkoutId: string): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM "AbandonedCheckoutReminder"
        WHERE "checkoutId" = $1 AND status = 'PENDING'
      `,
      [checkoutId],
    );
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "AbandonedCheckoutReminder" (
        "checkoutId" TEXT PRIMARY KEY,
        "phoneNumber" TEXT,
        "recoveryUrl" TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        "sentAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    this.logger.log('Abandoned checkout reminder storage is ready');
  }
}
