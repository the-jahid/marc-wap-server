import { ConfigService } from '@nestjs/config';
import { ConversationStoreService } from '../database/conversation-store.service';
import { ShopifyService } from '../shopify/shopify.service';
import type { AbandonedCheckout } from '../shopify/shopify.types';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  AbandonedCheckoutConfig,
  AbandonedCheckoutConfigStore,
} from './abandoned-checkout-config.store';
import {
  AbandonedCheckoutReminderStore,
  REMINDER_STATUS,
  type ReminderRecord,
} from './abandoned-checkout-reminder.store';
import { AbandonedCheckoutService } from './abandoned-checkout.service';

const emptyConfigService = {
  get: jest.fn(() => undefined),
} as unknown as ConfigService;

const HOUR_MS = 3_600_000;
const NOW = Date.parse('2026-07-15T12:00:00Z');

const buildCheckout = (
  overrides: Partial<AbandonedCheckout> = {},
): AbandonedCheckout => ({
  id: 'gid://shopify/AbandonedCheckout/1',
  createdAt: '2026-07-14T10:00:00Z',
  completedAt: null,
  recoveryUrl: 'https://shop.example/checkout/recover/abc',
  customerFirstName: 'Ana',
  email: 'ana@example.com',
  phone: '34612345678',
  total: '49.90 EUR',
  items: [{ title: 'Sujetador', quantity: 1 }],
  ...overrides,
});

const buildRecord = (
  overrides: Partial<ReminderRecord> = {},
): ReminderRecord => ({
  checkoutId: 'gid://shopify/AbandonedCheckout/1',
  phoneNumber: '34612345678',
  email: 'ana@example.com',
  customerName: 'Ana',
  items: [{ title: 'Sujetador', quantity: 1 }],
  recoveryUrl: 'https://shop.example/checkout/recover/abc',
  status: REMINDER_STATUS.MESSAGE_SENT,
  messageCount: 1,
  firstMessageAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
  secondMessageAt: null,
  respondedAt: null,
  recoveredAt: null,
  transferredAt: null,
  createdAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
  updatedAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
  ...overrides,
});

type Mocks = {
  shopify: { isConfigured: jest.Mock; findRecentAbandonedCheckouts: jest.Mock };
  whatsapp: { canSendMessages: jest.Mock; sendManualText: jest.Mock };
  reminder: {
    claim: jest.Mock;
    markFirstSent: jest.Mock;
    claimSecond: jest.Mock;
    releaseSecond: jest.Mock;
    markResponded: jest.Mock;
    markTransferred: jest.Mock;
    markRecovered: jest.Mock;
    markNoResponse: jest.Mock;
    release: jest.Mock;
    get: jest.Mock;
    list: jest.Mock;
  };
  config: { getConfig: jest.Mock };
  conversation: { saveMessage: jest.Mock; getEngagementSince: jest.Mock };
};

const buildService = (
  checkouts: AbandonedCheckout[],
  configOverrides: Partial<AbandonedCheckoutConfig> = {},
): { service: AbandonedCheckoutService; mocks: Mocks } => {
  const config: AbandonedCheckoutConfig = {
    enabled: true,
    messageTemplate: 'Hola {{name}}, tu carrito: {{link}}',
    delayMinutes: 60,
    secondReminderEnabled: true,
    secondMessageTemplate: '¿Sigues ahí {{name}}? {{link}}',
    secondDelayHours: 22,
    updatedAt: null,
    ...configOverrides,
  };

  const mocks: Mocks = {
    shopify: {
      isConfigured: jest.fn().mockReturnValue(true),
      findRecentAbandonedCheckouts: jest.fn().mockResolvedValue(checkouts),
    },
    whatsapp: {
      canSendMessages: jest.fn().mockReturnValue(true),
      sendManualText: jest.fn().mockResolvedValue(undefined),
    },
    reminder: {
      claim: jest.fn().mockResolvedValue(true),
      markFirstSent: jest.fn().mockResolvedValue(undefined),
      claimSecond: jest.fn().mockResolvedValue(true),
      releaseSecond: jest.fn().mockResolvedValue(undefined),
      markResponded: jest.fn().mockResolvedValue(true),
      markTransferred: jest.fn().mockResolvedValue(true),
      markRecovered: jest.fn().mockResolvedValue(false),
      markNoResponse: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    },
    config: {
      getConfig: jest.fn().mockResolvedValue(config),
    },
    conversation: {
      saveMessage: jest.fn().mockResolvedValue(undefined),
      getEngagementSince: jest
        .fn()
        .mockResolvedValue({ inboundCount: 0, needsHumanAttention: false }),
    },
  };

  const service = new AbandonedCheckoutService(
    emptyConfigService,
    mocks.shopify as unknown as ShopifyService,
    mocks.whatsapp as unknown as WhatsappService,
    mocks.reminder as unknown as AbandonedCheckoutReminderStore,
    mocks.config as unknown as AbandonedCheckoutConfigStore,
    mocks.conversation as unknown as ConversationStoreService,
  );

  return { service, mocks };
};

describe('AbandonedCheckoutService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('first reminder', () => {
    it('sends the rendered message and records the full cart for a new checkout', async () => {
      const { service, mocks } = buildService([buildCheckout()]);

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claim).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(mocks.whatsapp.sendManualText).toHaveBeenCalledWith(
        '34612345678',
        'Hola Ana, tu carrito: https://shop.example/checkout/recover/abc',
      );
      expect(mocks.reminder.markFirstSent).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
        {
          phoneNumber: '34612345678',
          email: 'ana@example.com',
          customerName: 'Ana',
          items: [{ title: 'Sujetador', quantity: 1 }],
          recoveryUrl: 'https://shop.example/checkout/recover/abc',
        },
      );
      expect(mocks.conversation.saveMessage).toHaveBeenCalledWith(
        '34612345678',
        'ASSISTANT',
        'Hola Ana, tu carrito: https://shop.example/checkout/recover/abc',
      );
      expect(result).toMatchObject({ skipped: false, scanned: 1, sent: 1 });
    });

    it('honours the operator-configured delay when querying Shopify', async () => {
      const { service, mocks } = buildService([], { delayMinutes: 90 });

      await service.runOnce(NOW);

      expect(mocks.shopify.findRecentAbandonedCheckouts).toHaveBeenCalledWith(
        expect.objectContaining({ delayMs: 90 * 60_000 }),
      );
    });

    it('falls back to a generic name when the customer has none', async () => {
      const { service, mocks } = buildService([
        buildCheckout({ customerFirstName: null }),
      ]);

      await service.runOnce(NOW);

      expect(mocks.whatsapp.sendManualText).toHaveBeenCalledWith(
        '34612345678',
        'Hola cliente, tu carrito: https://shop.example/checkout/recover/abc',
      );
    });

    it('skips a checkout without a valid phone number', async () => {
      const { service, mocks } = buildService([buildCheckout({ phone: null })]);

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claim).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: 0, skippedNoPhone: 1 });
    });

    it('skips a checkout without a recovery link', async () => {
      const { service, mocks } = buildService([
        buildCheckout({ recoveryUrl: null }),
      ]);

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claim).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: 0, skippedNoRecoveryUrl: 1 });
    });

    it('does not send when another cycle already claimed the checkout', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.claim.mockResolvedValue(false);

      const result = await service.runOnce(NOW);

      expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
      expect(mocks.reminder.markFirstSent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: 0, skippedAlreadySent: 1 });
    });

    it('releases the claim so a failed send can be retried later', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.whatsapp.sendManualText.mockRejectedValue(
        new Error('WhatsApp down'),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.release).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(mocks.reminder.markFirstSent).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: 0, failed: 1 });
    });
  });

  describe('recovery and completion', () => {
    it('marks a messaged cart recovered once its order is completed', async () => {
      const { service, mocks } = buildService([
        buildCheckout({ completedAt: '2026-07-15T11:30:00Z' }),
      ]);
      mocks.reminder.markRecovered.mockResolvedValue(true);

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.markRecovered).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
      expect(result).toMatchObject({ recovered: 1, sent: 0 });
    });

    it('never messages a checkout that was completed before we reached it', async () => {
      const { service, mocks } = buildService([
        buildCheckout({ completedAt: '2026-07-15T11:30:00Z' }),
      ]);
      mocks.reminder.markRecovered.mockResolvedValue(false);

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claim).not.toHaveBeenCalled();
      expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: 0, skippedCompleted: 1 });
    });
  });

  describe('second reminder', () => {
    it('sends the follow-up once the delay has passed with no reply', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 23 * HOUR_MS).toISOString() }),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claimSecond).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(mocks.whatsapp.sendManualText).toHaveBeenCalledWith(
        '34612345678',
        '¿Sigues ahí Ana? https://shop.example/checkout/recover/abc',
      );
      expect(result).toMatchObject({ secondSent: 1, sent: 0 });
    });

    it('does not send the follow-up before its delay', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 3 * HOUR_MS).toISOString() }),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claimSecond).not.toHaveBeenCalled();
      expect(result).toMatchObject({ secondSent: 0, sent: 0 });
    });

    it('does not send the follow-up when it is switched off', async () => {
      const { service, mocks } = buildService([buildCheckout()], {
        secondReminderEnabled: false,
      });
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 23 * HOUR_MS).toISOString() }),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.claimSecond).not.toHaveBeenCalled();
      expect(result.secondSent).toBe(0);
    });

    it('reverts the follow-up claim when its send fails', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 23 * HOUR_MS).toISOString() }),
      );
      mocks.whatsapp.sendManualText.mockRejectedValue(new Error('down'));

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.releaseSecond).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(result).toMatchObject({ secondSent: 0, failed: 1 });
    });
  });

  describe('engagement', () => {
    it('stops the follow-up and records a reply when the customer writes back', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 23 * HOUR_MS).toISOString() }),
      );
      mocks.conversation.getEngagementSince.mockResolvedValue({
        inboundCount: 2,
        needsHumanAttention: false,
      });

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.markResponded).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(mocks.reminder.claimSecond).not.toHaveBeenCalled();
      expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
      expect(result).toMatchObject({ responded: 1, secondSent: 0 });
    });

    it('records a hand-off when the reply is flagged for a human', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(buildRecord());
      mocks.conversation.getEngagementSince.mockResolvedValue({
        inboundCount: 1,
        needsHumanAttention: true,
      });

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.markTransferred).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(result).toMatchObject({ transferred: 1 });
    });
  });

  describe('no response', () => {
    it('closes out a silent cart once the window has passed', async () => {
      const { service, mocks } = buildService([buildCheckout()], {
        secondReminderEnabled: false,
      });
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ firstMessageAt: new Date(NOW - 30 * HOUR_MS).toISOString() }),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.reminder.markNoResponse).toHaveBeenCalledWith(
        'gid://shopify/AbandonedCheckout/1',
      );
      expect(result).toMatchObject({ noResponse: 1 });
    });

    it('leaves a cart in a terminal state untouched', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.reminder.get.mockResolvedValue(
        buildRecord({ status: REMINDER_STATUS.RECOVERED }),
      );

      const result = await service.runOnce(NOW);

      expect(mocks.conversation.getEngagementSince).not.toHaveBeenCalled();
      expect(mocks.reminder.claimSecond).not.toHaveBeenCalled();
      expect(mocks.reminder.markNoResponse).not.toHaveBeenCalled();
      expect(result.scanned).toBe(1);
    });
  });

  describe('guards', () => {
    it('does nothing when recovery is switched off', async () => {
      const { service, mocks } = buildService([buildCheckout()], {
        enabled: false,
      });

      const result = await service.runOnce(NOW);

      expect(result).toMatchObject({ skipped: true, reason: 'disabled' });
      expect(mocks.shopify.findRecentAbandonedCheckouts).not.toHaveBeenCalled();
    });

    it('reports not-configured when infrastructure is missing', async () => {
      const { service, mocks } = buildService([buildCheckout()]);
      mocks.shopify.isConfigured.mockReturnValue(false);

      const result = await service.runOnce(NOW);

      expect(result).toMatchObject({ skipped: true, reason: 'not-configured' });
      expect(mocks.config.getConfig).not.toHaveBeenCalled();
    });
  });
});
