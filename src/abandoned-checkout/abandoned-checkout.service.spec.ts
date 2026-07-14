import { ConfigService } from '@nestjs/config';
import { ConversationStoreService } from '../database/conversation-store.service';
import { ShopifyService } from '../shopify/shopify.service';
import type { AbandonedCheckout } from '../shopify/shopify.types';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  AbandonedCheckoutConfig,
  AbandonedCheckoutConfigStore,
} from './abandoned-checkout-config.store';
import { AbandonedCheckoutReminderStore } from './abandoned-checkout-reminder.store';
import { AbandonedCheckoutService } from './abandoned-checkout.service';

const emptyConfigService = {
  get: jest.fn(() => undefined),
} as unknown as ConfigService;

const buildCheckout = (
  overrides: Partial<AbandonedCheckout> = {},
): AbandonedCheckout => ({
  id: 'gid://shopify/AbandonedCheckout/1',
  createdAt: '2026-07-14T10:00:00Z',
  completedAt: null,
  recoveryUrl: 'https://shop.example/checkout/recover/abc',
  customerFirstName: 'Ana',
  phone: '34612345678',
  total: '49.90 EUR',
  items: [{ title: 'Sujetador', quantity: 1 }],
  ...overrides,
});

type Mocks = {
  shopify: { isConfigured: jest.Mock; findRecentAbandonedCheckouts: jest.Mock };
  whatsapp: { canSendMessages: jest.Mock; sendManualText: jest.Mock };
  reminder: { claim: jest.Mock; markSent: jest.Mock; release: jest.Mock };
  config: { getConfig: jest.Mock };
  conversation: { saveMessage: jest.Mock };
};

const buildService = (
  checkouts: AbandonedCheckout[],
  configOverrides: Partial<AbandonedCheckoutConfig> = {},
): { service: AbandonedCheckoutService; mocks: Mocks } => {
  const config: AbandonedCheckoutConfig = {
    enabled: true,
    messageTemplate: 'Hola {{name}}, tu carrito: {{link}}',
    delayMinutes: 60,
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
      markSent: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    },
    config: {
      getConfig: jest.fn().mockResolvedValue(config),
    },
    conversation: {
      saveMessage: jest.fn().mockResolvedValue(undefined),
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

  it('sends the rendered message and records it for an eligible checkout', async () => {
    const { service, mocks } = buildService([buildCheckout()]);

    const result = await service.runOnce();

    expect(mocks.reminder.claim).toHaveBeenCalledWith(
      'gid://shopify/AbandonedCheckout/1',
    );
    expect(mocks.whatsapp.sendManualText).toHaveBeenCalledWith(
      '34612345678',
      'Hola Ana, tu carrito: https://shop.example/checkout/recover/abc',
    );
    expect(mocks.reminder.markSent).toHaveBeenCalledWith(
      'gid://shopify/AbandonedCheckout/1',
      '34612345678',
      'https://shop.example/checkout/recover/abc',
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

    await service.runOnce(0);

    expect(mocks.shopify.findRecentAbandonedCheckouts).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 90 * 60_000 }),
    );
  });

  it('falls back to a generic name when the customer has none', async () => {
    const { service, mocks } = buildService([
      buildCheckout({ customerFirstName: null }),
    ]);

    await service.runOnce();

    expect(mocks.whatsapp.sendManualText).toHaveBeenCalledWith(
      '34612345678',
      'Hola cliente, tu carrito: https://shop.example/checkout/recover/abc',
    );
  });

  it('skips a checkout that has already been completed', async () => {
    const { service, mocks } = buildService([
      buildCheckout({ completedAt: '2026-07-14T11:30:00Z' }),
    ]);

    const result = await service.runOnce();

    expect(mocks.reminder.claim).not.toHaveBeenCalled();
    expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skippedCompleted: 1 });
  });

  it('skips a checkout without a valid phone number', async () => {
    const { service, mocks } = buildService([buildCheckout({ phone: null })]);

    const result = await service.runOnce();

    expect(mocks.reminder.claim).not.toHaveBeenCalled();
    expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skippedNoPhone: 1 });
  });

  it('does not send when the checkout was already claimed', async () => {
    const { service, mocks } = buildService([buildCheckout()]);
    mocks.reminder.claim.mockResolvedValue(false);

    const result = await service.runOnce();

    expect(mocks.whatsapp.sendManualText).not.toHaveBeenCalled();
    expect(mocks.reminder.markSent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, skippedAlreadySent: 1 });
  });

  it('releases the claim so a failed send can be retried later', async () => {
    const { service, mocks } = buildService([buildCheckout()]);
    mocks.whatsapp.sendManualText.mockRejectedValue(new Error('WhatsApp down'));

    const result = await service.runOnce();

    expect(mocks.reminder.release).toHaveBeenCalledWith(
      'gid://shopify/AbandonedCheckout/1',
    );
    expect(mocks.reminder.markSent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
  });

  it('does nothing when recovery is switched off', async () => {
    const { service, mocks } = buildService([buildCheckout()], {
      enabled: false,
    });

    const result = await service.runOnce();

    expect(result).toMatchObject({ skipped: true, reason: 'disabled' });
    expect(mocks.shopify.findRecentAbandonedCheckouts).not.toHaveBeenCalled();
  });

  it('reports not-configured when infrastructure is missing', async () => {
    const { service, mocks } = buildService([buildCheckout()]);
    mocks.shopify.isConfigured.mockReturnValue(false);

    const result = await service.runOnce();

    expect(result).toMatchObject({ skipped: true, reason: 'not-configured' });
    expect(mocks.config.getConfig).not.toHaveBeenCalled();
  });
});
