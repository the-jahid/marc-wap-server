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

  it('sends a manual text message through the WhatsApp sender', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      sendWhatsAppText: (to: string, body: string) => Promise<void>;
    };
    const sendWhatsAppText = jest
      .spyOn(serviceInternals, 'sendWhatsAppText')
      .mockResolvedValue(undefined);

    await expect(
      service.sendManualText('15551234567', 'Manual reply'),
    ).resolves.toBeUndefined();

    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '15551234567',
      'Manual reply',
    );
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

  it('processes incoming voice messages using the transcription as user text', async () => {
    const service = new WhatsappService(configService);
    const invoke = jest.fn().mockResolvedValue({ content: 'Voice reply' });
    const serviceInternals = service as unknown as {
      createReply: (message: {
        from?: string;
        id?: string;
        type?: string;
        audio?: {
          id?: string;
          mime_type?: string;
          voice?: boolean;
        };
      }) => Promise<string>;
      downloadWhatsappMedia: (
        mediaId: string,
        webhookMimeType?: string,
      ) => Promise<{ data: Buffer; mimeType: string }>;
      transcribeAudio: (media: {
        data: Buffer;
        mimeType: string;
      }) => Promise<string>;
      getChatModel: () => { invoke: typeof invoke };
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
      ) => Promise<void>;
    };
    jest
      .spyOn(serviceInternals, 'downloadWhatsappMedia')
      .mockResolvedValue({ data: Buffer.from('voice'), mimeType: 'audio/ogg' });
    jest
      .spyOn(serviceInternals, 'transcribeAudio')
      .mockResolvedValue('What are your opening hours?');
    jest.spyOn(serviceInternals, 'getChatModel').mockReturnValue({ invoke });
    const saveConversationTurn = jest
      .spyOn(serviceInternals, 'saveConversationTurn')
      .mockResolvedValue(undefined);

    await expect(
      serviceInternals.createReply({
        from: '15551234567',
        id: 'wamid.voice',
        type: 'audio',
        audio: {
          id: 'media.1',
          mime_type: 'audio/ogg; codecs=opus',
          voice: true,
        },
      }),
    ).resolves.toBe('Voice reply');

    expect(serviceInternals.downloadWhatsappMedia).toHaveBeenCalledWith(
      'media.1',
      'audio/ogg; codecs=opus',
    );
    expect(serviceInternals.transcribeAudio).toHaveBeenCalledWith({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(saveConversationTurn).toHaveBeenCalledWith(
      '15551234567',
      'What are your opening hours?',
      'Voice reply',
    );
  });

  it('downloads WhatsApp media by resolving the temporary media URL', async () => {
    const service = new WhatsappService(configService);
    const voiceBuffer = Buffer.from('voice');
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            url: 'https://lookaside.fbsbx.com/voice',
            mime_type: 'audio/ogg',
            file_size: 5,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'audio/ogg' }),
        arrayBuffer: () =>
          Promise.resolve(
            voiceBuffer.buffer.slice(
              voiceBuffer.byteOffset,
              voiceBuffer.byteOffset + voiceBuffer.byteLength,
            ),
          ),
      } as Response);
    const serviceInternals = service as unknown as {
      downloadWhatsappMedia: (
        mediaId: string,
        webhookMimeType?: string,
      ) => Promise<{ data: Buffer; mimeType: string }>;
    };

    await expect(
      serviceInternals.downloadWhatsappMedia('media.1', 'audio/ogg'),
    ).resolves.toEqual({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://graph.facebook.com/v23.0/media.1',
      {
        headers: {
          Authorization: 'Bearer whatsapp-token',
        },
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://lookaside.fbsbx.com/voice',
      {
        headers: {
          Authorization: 'Bearer whatsapp-token',
        },
      },
    );

    fetchMock.mockRestore();
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

  it('loads the latest 15 user and AI conversation turns by phone number', async () => {
    const findLatestMessages = jest.fn().mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => {
        const id = index + 1;

        return {
          id,
          role: id % 2 === 1 ? 'USER' : 'ASSISTANT',
          content: `message ${id}`,
        };
      }),
    );
    const service = new WhatsappService(configService, {
      findLatestMessages,
    } as never);
    const serviceInternals = service as unknown as {
      getConversationHistory: (userId: string) => Promise<
        Array<{
          content: string;
        }>
      >;
    };

    const history =
      await serviceInternals.getConversationHistory('15551234567');

    expect(findLatestMessages).toHaveBeenCalledWith('15551234567', 30);
    expect(history).toHaveLength(30);
    expect(history[0]?.content).toBe('message 1');
    expect(history[29]?.content).toBe('message 30');
  });

  it('saves user and AI replies and trims stored history to 15 turns', async () => {
    const saveTurn = jest.fn().mockResolvedValue(undefined);
    const service = new WhatsappService(configService, {
      saveTurn,
    } as never);
    const serviceInternals = service as unknown as {
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
      ) => Promise<void>;
    };

    await serviceInternals.saveConversationTurn(
      '15551234567',
      'Hi',
      'Hello from AI',
    );

    expect(saveTurn).toHaveBeenCalledWith(
      '15551234567',
      'Hi',
      'Hello from AI',
      30,
    );
  });
});
