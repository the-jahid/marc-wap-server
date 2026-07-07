import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';
import type { WhatsappWebhookPayload } from './whatsapp.types';

describe('WhatsappService', () => {
  const config = {
    WHATSAPP_VERIFY_TOKEN: 'verify-token',
    WHATSAPP_API_KEY: 'whatsapp-token',
    WHATSAPP_PHONE_NUMBER_ID: '12345',
    OPENAI_API_KEY: 'openai-key',
  };

  const configService = {
    get: jest.fn((key: string) => config[key as keyof typeof config]),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates Meta webhook challenges with the configured token', () => {
    const service = new WhatsappService(configService);

    expect(
      service.isValidWebhookChallenge('subscribe', 'verify-token'),
    ).toBeTruthy();
    expect(
      service.isValidWebhookChallenge('subscribe', 'wrong-token'),
    ).toBeFalsy();
    expect(service.isValidWebhookChallenge('ping', 'verify-token')).toBeFalsy();
  });

  it('processes incoming text messages and ignores duplicate webhook retries', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      createReply: () => Promise<string>;
      sendWhatsAppText: (
        to: string,
        body: string,
        phoneNumberIdFromWebhook?: string,
      ) => Promise<void>;
    };
    const createReply = jest
      .spyOn(serviceInternals, 'createReply')
      .mockResolvedValue('Hello from AI');
    const sendWhatsAppText = jest
      .spyOn(serviceInternals, 'sendWhatsAppText')
      .mockResolvedValue(undefined);
    const payload: WhatsappWebhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: {
                  phone_number_id: '12345',
                },
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.1',
                    type: 'text',
                    text: {
                      body: 'Hi',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(service.processWebhook(payload)).resolves.toEqual({
      received: true,
      messagesReceived: 1,
      messagesProcessed: 1,
      repliesSent: 1,
      errors: 0,
    });
    await expect(service.processWebhook(payload)).resolves.toEqual({
      received: true,
      messagesReceived: 1,
      messagesProcessed: 0,
      repliesSent: 0,
      errors: 0,
    });

    expect(createReply).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '15551234567',
      'Hello from AI',
      '12345',
    );
  });

  it('acknowledges status-only webhook payloads without replying', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      sendWhatsAppText: (
        to: string,
        body: string,
        phoneNumberIdFromWebhook?: string,
      ) => Promise<void>;
    };
    const sendWhatsAppText = jest.spyOn(serviceInternals, 'sendWhatsAppText');
    const payload: WhatsappWebhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 'status.1' }],
              },
            },
          ],
        },
      ],
    };

    await expect(service.processWebhook(payload)).resolves.toEqual({
      received: true,
      messagesReceived: 0,
      messagesProcessed: 0,
      repliesSent: 0,
      errors: 0,
    });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it('acknowledges message webhooks when sending the reply fails', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      createReply: () => Promise<string>;
      sendWhatsAppText: (
        to: string,
        body: string,
        phoneNumberIdFromWebhook?: string,
      ) => Promise<void>;
    };
    jest.spyOn(serviceInternals, 'createReply').mockResolvedValue('Hello');
    jest
      .spyOn(serviceInternals, 'sendWhatsAppText')
      .mockRejectedValue(new Error('send failed'));
    const payload: WhatsappWebhookPayload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '15551234567',
                    id: 'wamid.send-failed',
                    type: 'text',
                    text: {
                      body: 'Hi',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(service.processWebhook(payload)).resolves.toEqual({
      received: true,
      messagesReceived: 1,
      messagesProcessed: 0,
      repliesSent: 0,
      errors: 1,
    });
  });
});
