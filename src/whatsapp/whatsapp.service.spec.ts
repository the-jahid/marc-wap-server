import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';
import type { WhatsappWebhookPayload } from './whatsapp.types';
import type { ShopifyService } from '../shopify/shopify.service';
import type { CustomerOrder } from '../shopify/shopify.types';

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

  describe('order lookup tool', () => {
    type ToolRunner = {
      runShopifyTool: (
        name: string,
        args: Record<string, unknown>,
        phone: string,
      ) => Promise<string>;
    };

    const withOrders = (orders: CustomerOrder[] = []) => {
      const findOrders = jest.fn((): Promise<CustomerOrder[]> =>
        Promise.resolve(orders),
      );
      const findOrdersForPhone = jest.fn((): Promise<CustomerOrder[]> =>
        Promise.resolve([]),
      );
      const shopify = {
        isConfigured: () => true,
        canSearchProducts: () => false,
        findOrders,
        findOrdersForPhone,
      } as unknown as ShopifyService;
      const service = new WhatsappService(
        configService,
        undefined,
        undefined,
        undefined,
        shopify,
      );

      return {
        findOrders,
        findOrdersForPhone,
        run: (args: Record<string, unknown>, phone = '34699888777') =>
          (service as unknown as ToolRunner).runShopifyTool(
            'lookup_orders',
            args,
            phone,
          ),
      };
    };

    it('searches the order number the customer quoted, not only their phone', async () => {
      const { findOrders, run } = withOrders();

      await run({ orderNumber: '#4054' });

      expect(findOrders).toHaveBeenCalledWith({
        orderNumber: '#4054',
        email: null,
        phone: '34699888777',
        customerName: null,
        trackingNumber: null,
      });
    });

    // A number the model read out of the chat is searched in addition to the
    // verified sender, never instead of it.
    it('keeps searching the verified phone when the model supplies another one', async () => {
      const { findOrders, findOrdersForPhone, run } = withOrders();

      await run({ phone: '34600111222' });

      expect(findOrders).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '34600111222' }),
      );
      expect(findOrdersForPhone).toHaveBeenCalledWith('34699888777');
    });

    it('drops blank identifiers rather than searching on them', async () => {
      const { findOrders, run } = withOrders();

      await run({ orderNumber: '  ', email: '', customerName: 42 });

      expect(findOrders).toHaveBeenCalledWith(
        expect.objectContaining({
          orderNumber: null,
          email: null,
          customerName: null,
        }),
      );
    });

    // The regression itself: a phone-only miss used to end the conversation.
    it('asks for an identifier instead of escalating when the phone alone finds nothing', async () => {
      const { run } = withOrders();

      const result = await run({});

      expect(result).toContain('NO_ORDERS_FOUND_BY_PHONE');
      expect(result).toMatch(/do not hand this to a human yet/i);
      expect(result).toMatch(/asking them for their order number/i);
    });

    it('allows a handoff once the identifiers the customer gave still find nothing', async () => {
      const { run } = withOrders();

      const result = await run({ orderNumber: '4054' });

      expect(result).toContain('NO_ORDERS_FOUND');
      expect(result).not.toContain('NO_ORDERS_FOUND_BY_PHONE');
      expect(result).toMatch(/flag the conversation for a human/i);
    });

    /**
     * The model routinely needs a second lookup: its first call finds nothing
     * under the sender's number, and only then does it retry with the order
     * number. A single-pass grounding leaves it answering "let me look that
     * up" with no results, so the rounds must actually chain.
     */
    it('runs a follow-up tool call so a phone miss can be retried by order number', async () => {
      const order: CustomerOrder = {
        name: '#4054',
        createdAt: '2026-07-01T10:00:00.000Z',
        fulfillmentStatus: 'IN_TRANSIT',
        financialStatus: 'PAID',
        total: '59.90 EUR',
        items: [{ title: 'SUJETADOR HAVANNA', quantity: 1 }],
        tracking: [],
      };
      const shopify = {
        isConfigured: () => true,
        canSearchProducts: () => false,
        findOrdersForPhone: () => Promise.resolve([]),
        findOrders: ({ orderNumber }: { orderNumber?: string | null }) =>
          Promise.resolve(orderNumber === '4054' ? [order] : []),
      } as unknown as ShopifyService;
      const service = new WhatsappService(
        configService,
        undefined,
        undefined,
        undefined,
        shopify,
      );

      const toolCall = (id: string, args: Record<string, unknown>) => ({
        id,
        name: 'lookup_orders',
        args,
      });
      // Round 1: search the sender's number. Round 2: retry with the number
      // the customer quoted. Round 3: satisfied, no more calls.
      const rounds = [
        { tool_calls: [toolCall('a', {})] },
        { tool_calls: [toolCall('b', { orderNumber: '4054' })] },
        { tool_calls: [] },
      ];
      let round = 0;
      const invoke = jest.fn(() => Promise.resolve(rounds[round++]));
      const chatModel = {
        bindTools: () => ({ invoke }),
      } as unknown as Parameters<
        typeof WhatsappService.prototype['groundInShopify']
      >[0];

      const grounded = await (
        service as unknown as {
          groundInShopify: (
            model: unknown,
            messages: unknown[],
            phone: string,
          ) => Promise<{ content: unknown }[]>;
        }
      ).groundInShopify(chatModel, [], '34699888777');

      expect(invoke).toHaveBeenCalledTimes(3);
      expect(
        grounded.map((message) => String(message.content)).join('\n'),
      ).toContain('Order #4054');
    });

    it('stops calling tools after the round limit instead of looping forever', async () => {
      const shopify = {
        isConfigured: () => true,
        canSearchProducts: () => false,
        findOrdersForPhone: () => Promise.resolve([]),
        findOrders: () => Promise.resolve([]),
      } as unknown as ShopifyService;
      const service = new WhatsappService(
        configService,
        undefined,
        undefined,
        undefined,
        shopify,
      );

      // A model that never stops asking for another lookup.
      const invoke = jest.fn(() =>
        Promise.resolve({
          tool_calls: [{ id: 'x', name: 'lookup_orders', args: {} }],
        }),
      );
      const chatModel = { bindTools: () => ({ invoke }) };

      await (
        service as unknown as {
          groundInShopify: (
            model: unknown,
            messages: unknown[],
            phone: string,
          ) => Promise<unknown[]>;
        }
      ).groundInShopify(chatModel, [], '34699888777');

      expect(invoke).toHaveBeenCalledTimes(3);
    });

    it('reports the order it found', async () => {
      const { run } = withOrders([
        {
          name: '#4054',
          createdAt: '2026-07-01T10:00:00.000Z',
          fulfillmentStatus: 'FULFILLED',
          financialStatus: 'PAID',
          total: '59.90 EUR',
          items: [{ title: 'SUJETADOR HAVANNA', quantity: 1 }],
          tracking: [{ number: 'ES12345678', company: 'SEUR', url: null }],
        },
      ]);

      const result = await run({ orderNumber: '4054' });

      expect(result).toContain('Order #4054');
      expect(result).toContain('fulfillment: FULFILLED');
      expect(result).toContain('SEUR ES12345678');
      expect(result).not.toContain('NO_ORDERS_FOUND');
    });
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

  it('converts Markdown formatting to WhatsApp-native formatting before sending', async () => {
    const service = new WhatsappService(configService);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    const aiReply = [
      'Sí, tenemos el **sujetador Deauville** en catálogo. Es un **sujetador reductor con aros**.',
      '',
      'Aparece en estos colores:',
      '',
      '•⁠ ⁠**Beige** – **114 €**',
      '•⁠ ⁠**Negro** – **114 €**',
      '- **Natural** – **114 €**',
    ].join('\n');

    await service.sendManualText('15551234567', aiReply);

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(requestInit.body as string) as {
      text: { body: string };
    };

    expect(sentBody.text.body).toBe(
      [
        'Sí, tenemos el *sujetador Deauville* en catálogo. Es un *sujetador reductor con aros*.',
        '',
        'Aparece en estos colores:',
        '',
        '- *Beige* – *114 €*',
        '- *Negro* – *114 €*',
        '- *Natural* – *114 €*',
      ].join('\n'),
    );
    expect(sentBody.text.body).not.toContain('**');

    fetchMock.mockRestore();
  });

  it('strips stray formatting symbols so the customer never sees them', async () => {
    const service = new WhatsappService(configService);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    await service.sendManualText(
      '15551234567',
      'Aquí tienes un `código` y un asterisco suelto * y una lista:\n' +
        '- _cursiva_ ~~tachado~~',
    );

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(requestInit.body as string) as {
      text: { body: string };
    };

    expect(sentBody.text.body).toBe(
      'Aquí tienes un código y un asterisco suelto y una lista:\n' +
        '- _cursiva_ ~tachado~',
    );

    fetchMock.mockRestore();
  });

  it('leaves URLs untouched when cleaning formatting', async () => {
    const service = new WhatsappService(configService);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);

    await service.sendManualText(
      '15551234567',
      'Míralo aquí: https://shop.example.com/producto_deauville~beige y avísame.',
    );

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(requestInit.body as string) as {
      text: { body: string };
    };

    expect(sentBody.text.body).toBe(
      'Míralo aquí: https://shop.example.com/producto_deauville~beige y avísame.',
    );

    fetchMock.mockRestore();
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
    const invoke = jest.fn().mockResolvedValue({
      reply: 'Voice reply',
      needsHumanAttention: false,
      attentionReason: '',
    });
    const withStructuredOutput = jest.fn().mockReturnValue({ invoke });
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
      getChatModel: () => {
        withStructuredOutput: typeof withStructuredOutput;
      };
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
        needsHumanAttention?: boolean,
        attentionReason?: string | null,
      ) => Promise<void>;
    };
    jest
      .spyOn(serviceInternals, 'downloadWhatsappMedia')
      .mockResolvedValue({ data: Buffer.from('voice'), mimeType: 'audio/ogg' });
    jest
      .spyOn(serviceInternals, 'transcribeAudio')
      .mockResolvedValue('What are your opening hours?');
    jest
      .spyOn(serviceInternals, 'getChatModel')
      .mockReturnValue({ withStructuredOutput });
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
      false,
      null,
    );
  });

  it('calculates a supported FR/ES bra size without calling the chat model', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      createReply: (message: {
        from?: string;
        id?: string;
        type?: string;
        text?: { body?: string };
      }) => Promise<string>;
      getChatModel: () => unknown;
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
        needsHumanAttention?: boolean,
        attentionReason?: string | null,
      ) => Promise<void>;
    };
    const getChatModel = jest.spyOn(serviceInternals, 'getChatModel');
    const saveConversationTurn = jest
      .spyOn(serviceInternals, 'saveConversationTurn')
      .mockResolvedValue(undefined);

    const reply = await serviceInternals.createReply({
      from: '15551234567',
      id: 'wamid.bra-size',
      type: 'text',
      text: { body: '83 and 113' },
    });

    expect(reply).toContain('100 I (FR/ES)');
    expect(reply).not.toContain(' EU');
    expect(getChatModel).not.toHaveBeenCalled();
    expect(saveConversationTurn).toHaveBeenCalledWith(
      '15551234567',
      '83 and 113',
      reply,
      false,
      null,
    );
  });

  it('flags unsupported bra measurements for a human advisor', async () => {
    const service = new WhatsappService(configService);
    const serviceInternals = service as unknown as {
      createReply: (message: {
        from?: string;
        id?: string;
        type?: string;
        text?: { body?: string };
      }) => Promise<string>;
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
        needsHumanAttention?: boolean,
        attentionReason?: string | null,
      ) => Promise<void>;
    };
    const saveConversationTurn = jest
      .spyOn(serviceInternals, 'saveConversationTurn')
      .mockResolvedValue(undefined);

    const reply = await serviceInternals.createReply({
      from: '15551234567',
      id: 'wamid.bra-size-unsupported',
      type: 'text',
      text: { body: '83 and 118' },
    });

    expect(reply).toContain('cannot calculate an approximate size safely');
    expect(saveConversationTurn).toHaveBeenCalledWith(
      '15551234567',
      '83 and 118',
      reply,
      true,
      expect.stringContaining('outside the supported FR/ES sizing table'),
    );
  });

  it('stores the advisor signal when a conversation needs human attention', async () => {
    const service = new WhatsappService(configService);
    const invoke = jest.fn().mockResolvedValue({
      reply: 'I cannot access that account. A team member will review this.',
      needsHumanAttention: true,
      attentionReason: 'Account access is required.',
    });
    const serviceInternals = service as unknown as {
      createReply: (message: {
        from?: string;
        id?: string;
        type?: string;
        text?: { body?: string };
      }) => Promise<string>;
      getChatModel: () => {
        withStructuredOutput: () => { invoke: typeof invoke };
      };
      saveConversationTurn: (
        userId: string,
        userText: string,
        assistantText: string,
        needsHumanAttention?: boolean,
        attentionReason?: string | null,
      ) => Promise<void>;
    };
    jest.spyOn(serviceInternals, 'getChatModel').mockReturnValue({
      withStructuredOutput: () => ({ invoke }),
    });
    const saveConversationTurn = jest
      .spyOn(serviceInternals, 'saveConversationTurn')
      .mockResolvedValue(undefined);

    await expect(
      serviceInternals.createReply({
        from: '15551234567',
        id: 'wamid.attention',
        type: 'text',
        text: { body: 'Can you change the billing owner on my account?' },
      }),
    ).resolves.toBe(
      'I cannot access that account. A team member will review this.',
    );

    expect(saveConversationTurn).toHaveBeenCalledWith(
      '15551234567',
      'Can you change the billing owner on my account?',
      'I cannot access that account. A team member will review this.',
      true,
      'Account access is required.',
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

  it('saves user and AI replies without trimming stored history', async () => {
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
      false,
      null,
    );
  });
});
