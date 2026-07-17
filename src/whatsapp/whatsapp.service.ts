import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import type {
  WhatsappInboundMessage,
  WhatsappMessageEnvelope,
  WhatsappWebhookPayload,
  WhatsappWebhookResult,
} from './whatsapp.types';
import {
  AgentConfigService,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from '../agent-config/agent-config.service';
import { CONVERSATION_STORE } from '../database/conversation-store.constants';
import type { ConversationStore } from '../database/conversation-store.service';
import { ShopifyService } from '../shopify/shopify.service';
import type {
  CustomerOrder,
  OrderIdentifiers,
  ProductSearchResult,
} from '../shopify/shopify.types';
import { createBraSizeReply } from './bra-size-calculator';

const MAX_CONVERSATION_MESSAGES = 15;
/** Routes every replica's requests at one cached prefix instead of one each. */
const PROMPT_CACHE_KEY = 'whatsapp-agent';
/**
 * A broad query like "sujetador" matches 172 products, and spelling each one
 * out with its full size grid costs ~43k tokens that are re-sent on every tool
 * round. No answer needs that many: the colour line below already spans the
 * whole family, so the cap only limits how many products are described in
 * full. Fewer, closer products also make the model likelier to read the right
 * size grid instead of the neighbouring one.
 */
const MAX_PRODUCTS_DESCRIBED = 8;
/**
 * Enough for the lookups that genuinely chain — search by the sender's number,
 * then by the order number they quoted — while still bounding a model that
 * loops on a tool that keeps returning nothing.
 */
const MAX_TOOL_ROUNDS = 3;
const MAX_TRANSCRIPTION_AUDIO_BYTES = 25 * 1024 * 1024;
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const CONVERSATION_ROLE = {
  USER: 'USER',
  ASSISTANT: 'ASSISTANT',
} as const;
const execFileAsync = promisify(execFile);

type DownloadedWhatsappMedia = {
  data: Buffer;
  mimeType: string;
};

type TranscriptionAudio = DownloadedWhatsappMedia & {
  filename: string;
};

type WhatsappMediaMetadata = {
  url?: string;
  mime_type?: string;
  file_size?: number;
};

type OpenAITranscriptionResponse = {
  text?: string;
};

type AdvisorReply = {
  reply: string;
  needsHumanAttention: boolean;
  attentionReason: string;
};

const ADVISOR_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'The concise WhatsApp reply that will be sent to the user.',
    },
    needsHumanAttention: {
      type: 'boolean',
      description:
        'True only when a person should review or take over: the user asks for a human, reports a serious complaint or urgent/high-risk issue, requests an action or private information the assistant cannot access, or the assistant cannot confidently resolve the request.',
    },
    attentionReason: {
      type: 'string',
      description:
        'A short internal reason for the human advisor. Use an empty string when human attention is not needed.',
    },
  },
  required: ['reply', 'needsHumanAttention', 'attentionReason'],
  additionalProperties: false,
} as const;

const ORDER_LOOKUP_TOOL_NAME = 'lookup_orders';

/**
 * The sender's verified WhatsApp number is always searched, and the model may
 * add any identifier the customer volunteered. Identifiers are OR-ed, so a
 * customer who quotes an order number is found even when they are messaging
 * from a number the order was never placed with — the case that used to dead-end
 * in a human handoff.
 *
 * The shop accepts the tradeoff this creates: order numbers are sequential, so
 * anyone who guesses one can read that order. Do not "fix" that here by
 * requiring a second identifier without asking the shop first.
 */
const ORDER_LOOKUP_TOOL = {
  type: 'function' as const,
  function: {
    name: ORDER_LOOKUP_TOOL_NAME,
    description:
      'Look up a customer order. Call this whenever the customer asks about an order, a delivery, ' +
      'shipping, tracking, a return or a refund. ' +
      'The customer’s own WhatsApp number is always searched automatically, so call this with no ' +
      'arguments first. If that finds nothing, pass whatever identifier the customer gives you: an ' +
      'order number, an email address, another phone number, the full name on the order, or a ' +
      'tracking number. Any single one of them is enough to find the order. ' +
      'Only pass values the customer actually stated — never guess an identifier. ' +
      'Never report an order that this tool did not return.',
    parameters: {
      type: 'object',
      properties: {
        orderNumber: {
          type: 'string',
          description:
            'The order number as the customer wrote it, e.g. "4054" or "#4054".',
        },
        email: {
          type: 'string',
          description:
            'The email address the customer says the order was placed with.',
        },
        phone: {
          type: 'string',
          description:
            'Another phone number the customer says the order was placed with. Do not pass the number they are messaging from; that is searched already.',
        },
        customerName: {
          type: 'string',
          description:
            'The full name on the order (first and last). Do not pass a first name on its own.',
        },
        trackingNumber: {
          type: 'string',
          description: 'A shipment tracking number the customer quotes.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const ORDER_LOOKUP_SYSTEM_PROMPT =
  `\n\nYou can look up orders with the ${ORDER_LOOKUP_TOOL_NAME} tool. ` +
  'The customer’s WhatsApp number is always searched automatically, so pass only the identifiers ' +
  'they actually gave you: an order number, email, another phone number, the full name on the ' +
  'order, or a tracking number. Any one of them finds the order on its own. If they have given ' +
  'none yet, call the tool with no arguments. ' +
  'If a lookup finds nothing, do NOT hand the conversation to a human: many customers order with ' +
  'a different phone number than the one they message from. Ask them for their order number and ' +
  'look it up when they reply. ' +
  'Only discuss orders the tool actually returned, and never invent one. ' +
  'Hand over to a human once a lookup with the identifiers they gave still finds nothing, or if ' +
  'they are upset, ask for a person, or have a real problem with their order.';

const PRODUCT_SEARCH_TOOL_NAME = 'search_products';

const PRODUCT_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: PRODUCT_SEARCH_TOOL_NAME,
    description:
      'Search the shop catalogue for products, prices and the sizes that are offered. ' +
      'Call this whenever the customer asks whether a garment exists, what it costs, ' +
      'or whether it comes in their size. Search with the product words the customer used ' +
      '(in Spanish), for example "sujetador reductor" or "faja". ' +
      'Always call it for colour, colourway, style, or model questions too, and include both ' +
      'the model name and garment type in the query (for example "Havanna bra"). Keep the ' +
      'query to those product-identifying words; omit conversational phrases such as "other colors". ' +
      'Never put a size, band number, cup letter or measurement in the query: search "sujetador ' +
      'sin aros", never "sujetador sin aros 120F". Sizes are not part of the product text, so a ' +
      'size in the query matches nothing. Sizes come back in the "sizes offered" line of each ' +
      'result; read that to answer any size question. ' +
      'Results are keyword matches, not exact answers: read the titles and descriptions ' +
      'and only tell the customer about products that genuinely match what they asked for.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "Product keywords to search for, in the customer's own language.",
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/**
 * This shop does not keep real stock counts: every variant carries a placeholder
 * quantity of roughly 10,000, so "available" means the size is offered for sale,
 * never that a garment is confirmed to be on the shelf. Promising stock we cannot
 * see would be a lie the shop has to absorb, so the model is told not to.
 */
const PRODUCT_SEARCH_SYSTEM_PROMPT =
  `\n\nYou can search the shop catalogue with the ${PRODUCT_SEARCH_TOOL_NAME} tool. ` +
  'Use it for any question about what the shop sells, what something costs, or which sizes exist. ' +
  'The sizes it returns are the combinations the shop offers, and you may tell the customer a size ' +
  'is available to order. You must NOT state stock quantities or promise that an item is physically ' +
  'in the warehouse, because the shop does not track stock levels. Never invent a product, a price ' +
  'or a size that the tool did not return. For a model/style colour question, the tool returns ' +
  'all colours across every matching product in that garment family: report that colour list, ' +
  'not just the first product. Answer the colour question directly; do not ask for a size or ' +
  'push the customer toward a purchase unless they also asked about sizing or ordering. Do not ' +
  'mention related garments (such as panties) unless the customer asked about them. If the tool ' +
  'finds nothing that matches, say so plainly. A search that returns nothing means those words ' +
  'matched no product; it never means a size is unavailable. Only the "sizes offered" line can ' +
  'tell you whether a size can be ordered, and your answer about a size must not change between ' +
  'messages unless the tool told you something new.';

/**
 * The reply is written in a second pass that has no tools bound, and nothing
 * runs after it is sent. A model that answers "let me check" has therefore
 * already spent its only chance to look: the promise reaches the customer and
 * is never kept. Tools have to be called in the same turn the customer asks.
 */
const TOOL_IMMEDIACY_SYSTEM_PROMPT =
  '\n\nThere is no background work and no later follow-up: this reply is all the ' +
  'customer gets. Never say you will check, look up, review, or come back with ' +
  'options. Call the tool now and answer with what it returns. Only ask the ' +
  'customer a question when you genuinely cannot search without the answer, and ' +
  'never ask twice for a detail they have already given.';

// Non-negotiable language rule. Appended to every system prompt regardless of
// the configurable agent prompt, so it cannot be overridden from the admin UI
// or by the customer. Always reply in Spanish, no matter what language the
// customer writes in or asks for.
const LANGUAGE_SYSTEM_PROMPT =
  '\n\nAlways reply in Spanish (español) and only in Spanish. This is an ' +
  'absolute rule: never reply in any other language, even if the customer ' +
  'writes in another language or explicitly asks you to respond in English or ' +
  'any other language. Regardless of the request, your reply must be in Spanish.';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly conversations = new Map<string, BaseMessage[]>();
  private readonly processedMessageIds = new Set<string>();
  private readonly processedMessageOrder: string[] = [];
  private readonly processingMessageIds = new Set<string>();
  private chatModel?: ChatOpenAI;
  private chatModelName?: string;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(CONVERSATION_STORE)
    private readonly conversationStore?: ConversationStore,
    @Optional()
    private readonly agentConfigService?: AgentConfigService,
    @Optional()
    private readonly shopifyService?: ShopifyService,
  ) {}

  isValidWebhookChallenge(mode?: string, verifyToken?: string): boolean {
    const expectedVerifyToken = this.configService
      .get<string>('WHATSAPP_VERIFY_TOKEN')
      ?.trim();

    return (
      mode === 'subscribe' &&
      Boolean(expectedVerifyToken) &&
      verifyToken === expectedVerifyToken
    );
  }

  async sendManualText(to: string, body: string): Promise<void> {
    await this.sendWhatsAppText(to, body);
  }

  /**
   * True when the server has what it needs to start a WhatsApp conversation on
   * its own: an access token and a configured phone number id. Inbound replies
   * can borrow the phone number id from the webhook, but a business-initiated
   * message (such as an abandoned-checkout reminder) has no webhook to borrow
   * from, so the id must be configured.
   */
  canSendMessages(): boolean {
    const token =
      this.configService.get<string>('WHATSAPP_ACCESS_TOKEN')?.trim() ||
      this.configService.get<string>('WHATSAPP_API_KEY')?.trim();
    const phoneNumberId = this.configService
      .get<string>('WHATSAPP_PHONE_NUMBER_ID')
      ?.trim();

    return Boolean(token && phoneNumberId);
  }

  async processWebhook(
    payload: WhatsappWebhookPayload,
  ): Promise<WhatsappWebhookResult> {
    const envelopes = this.extractMessageEnvelopes(payload);
    let messagesProcessed = 0;
    let repliesSent = 0;
    let errors = 0;

    for (const envelope of envelopes) {
      const { message } = envelope;

      if (!message.id || !message.from) {
        continue;
      }

      if (
        this.processedMessageIds.has(message.id) ||
        this.processingMessageIds.has(message.id)
      ) {
        continue;
      }

      this.processingMessageIds.add(message.id);

      try {
        const reply = await this.createReply(message);

        await this.sendWhatsAppText(
          message.from,
          reply,
          envelope.phoneNumberId,
        );

        this.rememberProcessedMessage(message.id);
        messagesProcessed += 1;
        repliesSent += 1;
      } catch (error) {
        errors += 1;
        this.rememberProcessedMessage(message.id);
        this.logger.error(
          `Failed to process WhatsApp message ${message.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      } finally {
        this.processingMessageIds.delete(message.id);
      }
    }

    return {
      received: true,
      messagesReceived: envelopes.length,
      messagesProcessed,
      repliesSent,
      errors,
    };
  }

  private async createReply(message: WhatsappInboundMessage): Promise<string> {
    const text = await this.extractUserText(message);

    if (!text) {
      return 'Please send a text or voice message. I can respond to both now.';
    }

    const braSizeReply = createBraSizeReply(text);

    if (braSizeReply) {
      await this.saveConversationTurn(
        message.from ?? '',
        text,
        braSizeReply.reply,
        braSizeReply.needsHumanAttention,
        braSizeReply.attentionReason,
      );

      return braSizeReply.reply;
    }

    const { systemPrompt, model } = await this.resolveAgentSettings();
    const chatModel = this.getChatModel(model);
    const userId = message.from ?? '';
    const history = await this.getConversationHistory(userId);
    const hasTools = this.canLookUpOrders(userId) || this.canSearchProducts();
    const shopifyPrompt = `${
      this.canLookUpOrders(userId) ? ORDER_LOOKUP_SYSTEM_PROMPT : ''
    }${this.canSearchProducts() ? PRODUCT_SEARCH_SYSTEM_PROMPT : ''}${
      hasTools ? TOOL_IMMEDIACY_SYSTEM_PROMPT : ''
    }`;
    const messages: BaseMessage[] = [
      new SystemMessage(
        `${systemPrompt}${shopifyPrompt}\n\nAct as an advisor to the human team as well as the customer-facing assistant. Flag the conversation for human attention only when a person genuinely needs to review or take over.${LANGUAGE_SYSTEM_PROMPT}`,
      ),
      ...history,
      new HumanMessage(text),
    ];

    const groundedMessages = await this.groundInShopify(
      chatModel,
      messages,
      userId,
    );

    const advisorReply = await this.generateAdvisorReply(
      chatModel,
      groundedMessages,
      text,
    );
    const reply = advisorReply.reply.trim();
    const finalReply =
      reply || 'Sorry, I could not generate a reply. Please try again.';
    const needsHumanAttention =
      advisorReply.needsHumanAttention || reply.length === 0;
    const attentionReason = needsHumanAttention
      ? (
          advisorReply.attentionReason.trim() ||
          'The AI advisor could not fully resolve this request.'
        ).slice(0, 240)
      : null;

    await this.saveConversationTurn(
      userId,
      text,
      finalReply,
      needsHumanAttention,
      attentionReason,
    );

    return finalReply;
  }

  private canLookUpOrders(customerPhone: string): boolean {
    return (
      Boolean(customerPhone) && this.shopifyService?.isConfigured() === true
    );
  }

  private canSearchProducts(): boolean {
    return this.shopifyService?.canSearchProducts() === true;
  }

  /**
   * Lets the model pull real orders and real catalogue data before it answers,
   * so the reply is grounded in Shopify rather than in whatever the model would
   * otherwise invent about a price, a size or a delivery.
   *
   * Tool calls run in a loop, not a single pass: one lookup routinely informs
   * the next. An order search by the customer's own number that finds nothing
   * has to be retried with the order number they quoted, and the model can only
   * do that if it gets another turn with the tools still bound. Without the
   * loop it answers "let me look that up" and never does.
   */
  private async groundInShopify(
    chatModel: ChatOpenAI,
    messages: BaseMessage[],
    customerPhone: string,
  ): Promise<BaseMessage[]> {
    const tools = [
      ...(this.canLookUpOrders(customerPhone) ? [ORDER_LOOKUP_TOOL] : []),
      ...(this.canSearchProducts() ? [PRODUCT_SEARCH_TOOL] : []),
    ];

    if (tools.length === 0) {
      return messages;
    }

    const modelWithTools = chatModel.bindTools(tools);
    let grounded = messages;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await modelWithTools.invoke(grounded);
        const toolCalls = response.tool_calls ?? [];

        // The model has everything it needs; let it write the reply.
        if (toolCalls.length === 0) {
          return grounded;
        }

        const results = await Promise.all(
          toolCalls.map((toolCall) =>
            this.runShopifyTool(toolCall.name, toolCall.args, customerPhone),
          ),
        );

        grounded = [
          ...grounded,
          response,
          ...toolCalls.map(
            (toolCall, index) =>
              new ToolMessage({
                tool_call_id: toolCall.id ?? '',
                name: toolCall.name,
                content: results[index],
              }),
          ),
        ];
      }

      this.logger.warn(
        `Order/product grounding hit the ${MAX_TOOL_ROUNDS}-round tool limit; ` +
          'answering with what has been gathered so far',
      );

      return grounded;
    } catch (error) {
      this.logger.warn(
        'Shopify lookup failed; replying without shop data',
        error instanceof Error ? error.stack : String(error),
      );

      // Partial tool results are still better grounding than none.
      return grounded;
    }
  }

  private async runShopifyTool(
    name: string,
    args: Record<string, unknown>,
    customerPhone: string,
  ): Promise<string> {
    if (
      name === ORDER_LOOKUP_TOOL_NAME &&
      this.canLookUpOrders(customerPhone)
    ) {
      const supplied = this.readOrderIdentifiers(args);
      // The sender's verified number is always searched. A phone the model
      // supplies is searched as well as, never instead of, that number.
      const orders = await this.shopifyService!.findOrders({
        ...supplied,
        phone: supplied.phone ?? customerPhone,
      });
      const extraOrders = supplied.phone
        ? await this.shopifyService!.findOrdersForPhone(customerPhone)
        : [];
      const merged = this.mergeOrders(orders, extraOrders);

      this.logger.log(
        `Order lookup for ${this.maskPhone(customerPhone)} ` +
          `[${this.describeIdentifiers(supplied)}] matched ${merged.length} order(s)`,
      );

      return this.describeOrders(merged, supplied);
    }

    if (name === PRODUCT_SEARCH_TOOL_NAME && this.canSearchProducts()) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';

      if (!query) {
        return 'NO_QUERY: ask the customer which product they mean.';
      }

      const products = await this.shopifyService!.searchProducts(query);

      this.logger.log(
        `Product search "${query}" matched ${products.matches.length} product(s)`,
      );

      return this.describeProducts(products);
    }

    return `UNAVAILABLE: the ${name} tool is not available right now.`;
  }

  private describeProducts(result: ProductSearchResult): string {
    if (result.matches.length === 0) {
      return (
        'NO_PRODUCTS_FOUND. No product matched those search words. This says nothing ' +
        'about sizes: sizes are never searched, so never tell the customer a size is ' +
        'unavailable because of this result. If the query contained a size, a cup ' +
        'letter or a measurement, search again with the product words alone and read ' +
        'the "sizes offered" line. Otherwise do not invent a product: tell the ' +
        'customer you could not find it, and offer to pass them to a colleague.'
      );
    }

    const colors = result.colors.length
      ? `COLOURS FOR ${result.model}: ${result.colors.join(', ')}`
      : `COLOURS FOR ${result.model}: no colour information is recorded in Shopify.`;

    const listed = result.matches.slice(0, MAX_PRODUCTS_DESCRIBED);
    const omitted = result.matches.length - listed.length;

    return [
      colors,
      ...(omitted > 0
        ? [
            `Showing the ${listed.length} closest of ${result.matches.length} matching ` +
              `products. ${omitted} more were not listed: if none of these is what the ` +
              'customer means, search again with narrower words rather than guessing.',
          ]
        : []),
      ...listed.map((product) =>
        [
          product.title,
          `colours on this product: ${product.colors.join(', ') || 'not recorded'}`,
          `price: ${product.price}`,
          `sizes offered: ${product.sizes}`,
          product.url ? `link: ${product.url}` : 'link: not published online',
          `about: ${product.description}`,
        ].join('\n'),
      ),
    ].join('\n\n');
  }

  /**
   * Reads the identifiers the model passed, keeping only non-empty strings.
   * A blank or non-string argument is dropped rather than searched: an empty
   * identifier matches nothing, but an empty *set* of identifiers would make
   * the lookup fall back to a bare recent-orders scan.
   */
  private readOrderIdentifiers(
    args: Record<string, unknown>,
  ): OrderIdentifiers {
    const read = (key: string): string | null => {
      const value = args[key];

      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };

    return {
      orderNumber: read('orderNumber'),
      email: read('email'),
      phone: read('phone'),
      customerName: read('customerName'),
      trackingNumber: read('trackingNumber'),
    };
  }

  private mergeOrders(...groups: CustomerOrder[][]): CustomerOrder[] {
    const byName = new Map<string, CustomerOrder>();

    for (const order of groups.flat()) {
      byName.set(order.name, order);
    }

    return [...byName.values()];
  }

  private describeIdentifiers(identifiers: OrderIdentifiers): string {
    const supplied = Object.entries(identifiers)
      .filter(([, value]) => value)
      .map(([key]) => key);

    return supplied.length ? supplied.join(', ') : 'verified phone only';
  }

  private describeOrders(
    orders: CustomerOrder[],
    supplied: OrderIdentifiers = {},
  ): string {
    if (orders.length === 0) {
      const askedWith = Object.values(supplied).some(Boolean);

      // The customer gave us nothing but their number yet: the order is very
      // often placed under a different one, so ask before escalating.
      if (!askedWith) {
        return (
          'NO_ORDERS_FOUND_BY_PHONE. No order is registered to the number this customer ' +
          'is messaging from — but that is common and does NOT mean they have no order. ' +
          'Do not hand this to a human yet, and do not tell them their order does not exist. ' +
          'If they have already mentioned an order number, email, phone number, full name or ' +
          `tracking number anywhere in this conversation, call ${ORDER_LOOKUP_TOOL_NAME} again ` +
          'now, passing that value. If they have not, reply asking them for their order number ' +
          '(or email, phone, full name or tracking number) and wait for their answer.'
        );
      }

      return (
        'NO_ORDERS_FOUND. Nothing matched the identifiers the customer gave. Do not invent ' +
        'an order. If they have not tried another identifier yet, ask for one (order number, ' +
        'email, phone, full name or tracking number). If they have, tell them you cannot ' +
        'locate the order and flag the conversation for a human colleague to check.'
      );
    }

    return orders
      .map((order) => {
        const items =
          order.items
            .map((item) => `${item.quantity}x ${item.title}`)
            .join(', ') || 'unknown items';
        const tracking =
          order.tracking
            .filter((entry) => entry.number)
            .map((entry) =>
              [entry.company, entry.number, entry.url]
                .filter(Boolean)
                .join(' '),
            )
            .join('; ') || 'not shipped yet, no tracking number';

        return [
          `Order ${order.name}`,
          `placed: ${order.createdAt}`,
          `fulfillment: ${order.fulfillmentStatus}`,
          `payment: ${order.financialStatus}`,
          `total: ${order.total}`,
          `items: ${items}`,
          `tracking: ${tracking}`,
        ].join('\n');
      })
      .join('\n\n');
  }

  private maskPhone(phone: string): string {
    return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
  }

  private async generateAdvisorReply(
    chatModel: ChatOpenAI,
    messages: BaseMessage[],
    userText: string,
  ): Promise<AdvisorReply> {
    try {
      const structuredModel = chatModel.withStructuredOutput<AdvisorReply>(
        ADVISOR_REPLY_SCHEMA,
        {
          name: 'whatsapp_advisor_reply',
          method: 'jsonSchema',
          strict: true,
        },
      );
      const response = await structuredModel.invoke(messages);

      return {
        reply: response.reply ?? '',
        needsHumanAttention: response.needsHumanAttention === true,
        attentionReason: response.attentionReason ?? '',
      };
    } catch (error) {
      this.logger.warn(
        'Structured advisor response failed; using a plain reply',
        error instanceof Error ? error.stack : String(error),
      );

      const response = await chatModel.invoke(messages);
      const reply = this.contentToText(response.content).trim();
      const fallbackSignal = this.inferHumanAttention(userText, reply);

      return {
        reply,
        ...fallbackSignal,
      };
    }
  }

  private inferHumanAttention(
    userText: string,
    reply: string,
  ): Pick<AdvisorReply, 'needsHumanAttention' | 'attentionReason'> {
    const combinedText = `${userText}\n${reply}`.toLowerCase();
    const escalationPatterns = [
      /\b(human|person|representative|agent|manager|supervisor)\b/,
      /\b(complaint|refund|fraud|scam|legal|emergency|urgent)\b/,
      /\b(i (?:do not|don't) have|i cannot|i can't|unable to|not available)\b/,
    ];
    const needsHumanAttention = escalationPatterns.some((pattern) =>
      pattern.test(combinedText),
    );

    return {
      needsHumanAttention,
      attentionReason: needsHumanAttention
        ? 'The conversation may require information, action, or judgment from a human advisor.'
        : '',
    };
  }

  private async extractUserText(
    message: WhatsappInboundMessage,
  ): Promise<string | null> {
    const text = message.text?.body?.trim();

    if (message.type === 'text' && text) {
      return text;
    }

    if (message.type !== 'audio') {
      return null;
    }

    const mediaId = message.audio?.id;

    if (!mediaId) {
      return null;
    }

    const media = await this.downloadWhatsappMedia(
      mediaId,
      message.audio?.mime_type,
    );
    const transcript = await this.transcribeAudio(media);

    return transcript || null;
  }

  private getChatModel(model: string): ChatOpenAI {
    if (this.chatModel && this.chatModelName === model) {
      return this.chatModel;
    }

    const apiKey = this.getRequiredConfig(['OPENAI_API_KEY']);

    // Reasoning models reject function tools on /v1/chat/completions, so the
    // whole Shopify grounding pass 400s and the agent answers about sizes and
    // orders with no shop data at all. /v1/responses takes tools and reasoning
    // together, and serves the non-reasoning models just as well.
    this.chatModel = new ChatOpenAI({
      apiKey,
      model,
      maxRetries: 2,
      useResponsesApi: true,
      // Every reply repeats the same ~1.5k-token preamble of system prompt and
      // tool instructions — comfortably over the 1k-token minimum a prefix must
      // reach to be cached at all — which OpenAI bills at a tenth of the input
      // rate once cached. The key keeps replicas reading one cache rather than
      // one each. Retention is pinned rather than left to the org's data
      // policy, under which a ZDR org would fall back to in-memory and start
      // almost every conversation cold, customers writing hours apart.
      promptCacheKey: PROMPT_CACHE_KEY,
      promptCacheRetention: '24h',
    });
    this.chatModelName = model;

    return this.chatModel;
  }

  private async resolveAgentSettings(): Promise<{
    systemPrompt: string;
    model: string;
  }> {
    let storedSystemPrompt: string | undefined;
    let storedModel: string | undefined;

    if (this.agentConfigService) {
      try {
        const stored = await this.agentConfigService.getConfig();
        storedSystemPrompt = stored.systemPrompt?.trim() || undefined;
        storedModel = stored.model?.trim() || undefined;
      } catch (error) {
        this.logger.warn(
          'Failed to load stored agent config; falling back to environment',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return {
      systemPrompt:
        storedSystemPrompt ||
        this.configService.get<string>('CHATBOT_SYSTEM_PROMPT')?.trim() ||
        DEFAULT_SYSTEM_PROMPT,
      model:
        storedModel ||
        this.configService.get<string>('OPENAI_MODEL')?.trim() ||
        DEFAULT_MODEL,
    };
  }

  private async sendWhatsAppText(
    to: string,
    body: string,
    phoneNumberIdFromWebhook?: string,
  ): Promise<void> {
    const accessToken = this.getRequiredConfig([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_API_KEY',
    ]);
    const phoneNumberId =
      this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID')?.trim() ||
      phoneNumberIdFromWebhook;
    const graphApiVersion =
      this.configService.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() ||
      'v23.0';

    if (!phoneNumberId) {
      throw new InternalServerErrorException(
        'Missing WHATSAPP_PHONE_NUMBER_ID configuration',
      );
    }

    const response = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: false,
            body: this.limitWhatsappText(this.formatForWhatsapp(body)),
          },
        }),
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      throw new InternalServerErrorException(
        `WhatsApp API reply failed with HTTP ${response.status}: ${responseBody}`,
      );
    }
  }

  private async downloadWhatsappMedia(
    mediaId: string,
    webhookMimeType?: string,
  ): Promise<DownloadedWhatsappMedia> {
    const accessToken = this.getRequiredConfig([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_API_KEY',
    ]);
    const graphApiVersion =
      this.configService.get<string>('WHATSAPP_GRAPH_API_VERSION')?.trim() ||
      'v23.0';

    const metadataResponse = await fetch(
      `https://graph.facebook.com/${graphApiVersion}/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!metadataResponse.ok) {
      const responseBody = await metadataResponse.text();
      throw new InternalServerErrorException(
        `WhatsApp media lookup failed with HTTP ${metadataResponse.status}: ${responseBody}`,
      );
    }

    const metadata = (await metadataResponse.json()) as WhatsappMediaMetadata;

    if (!metadata.url) {
      throw new InternalServerErrorException(
        'WhatsApp media lookup did not include a download URL',
      );
    }

    if (
      metadata.file_size &&
      metadata.file_size > MAX_TRANSCRIPTION_AUDIO_BYTES
    ) {
      throw new InternalServerErrorException(
        'WhatsApp voice message is too large to transcribe',
      );
    }

    const mediaResponse = await fetch(metadata.url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!mediaResponse.ok) {
      const responseBody = await mediaResponse.text();
      throw new InternalServerErrorException(
        `WhatsApp media download failed with HTTP ${mediaResponse.status}: ${responseBody}`,
      );
    }

    const data = Buffer.from(await mediaResponse.arrayBuffer());

    if (data.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw new InternalServerErrorException(
        'WhatsApp voice message is too large to transcribe',
      );
    }

    return {
      data,
      mimeType:
        mediaResponse.headers.get('content-type') ||
        metadata.mime_type ||
        webhookMimeType ||
        'application/octet-stream',
    };
  }

  private async transcribeAudio(
    media: DownloadedWhatsappMedia,
  ): Promise<string> {
    const audio = await this.prepareAudioForTranscription(media);
    const apiKey = this.getRequiredConfig(['OPENAI_API_KEY']);
    const model =
      this.configService.get<string>('OPENAI_TRANSCRIPTION_MODEL')?.trim() ||
      DEFAULT_TRANSCRIPTION_MODEL;
    const formData = new FormData();
    formData.set('model', model);
    formData.set(
      'file',
      new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }),
      audio.filename,
    );

    const response = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const responseBody = await response.text();
      throw new InternalServerErrorException(
        `OpenAI transcription failed with HTTP ${response.status}: ${responseBody}`,
      );
    }

    const payload = (await response.json()) as OpenAITranscriptionResponse;

    return payload.text?.trim() ?? '';
  }

  private async prepareAudioForTranscription(
    media: DownloadedWhatsappMedia,
  ): Promise<TranscriptionAudio> {
    const extension = this.getSupportedTranscriptionExtension(media.mimeType);

    if (extension) {
      return {
        ...media,
        filename: `voice.${extension}`,
      };
    }

    return this.convertAudioToWav(media);
  }

  private async convertAudioToWav(
    media: DownloadedWhatsappMedia,
  ): Promise<TranscriptionAudio> {
    if (!ffmpegPath) {
      throw new InternalServerErrorException(
        'FFmpeg is unavailable; cannot convert WhatsApp voice message audio',
      );
    }

    const tempDirectory = await mkdtemp(join(tmpdir(), 'whatsapp-voice-'));
    const inputPath = join(
      tempDirectory,
      `input.${this.getAudioExtension(media.mimeType)}`,
    );
    const outputPath = join(tempDirectory, 'voice.wav');

    try {
      await writeFile(inputPath, media.data);
      await execFileAsync(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        outputPath,
      ]);

      const data = await readFile(outputPath);

      if (data.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
        throw new InternalServerErrorException(
          'Converted WhatsApp voice message is too large to transcribe',
        );
      }

      return {
        data,
        mimeType: 'audio/wav',
        filename: 'voice.wav',
      };
    } finally {
      await rm(tempDirectory, { force: true, recursive: true });
    }
  }

  private getSupportedTranscriptionExtension(mimeType: string): string | null {
    const normalizedMimeType = mimeType.toLowerCase();

    if (normalizedMimeType.includes('mpeg')) {
      return 'mp3';
    }

    if (normalizedMimeType.includes('mp4')) {
      return 'mp4';
    }

    if (normalizedMimeType.includes('m4a')) {
      return 'm4a';
    }

    if (normalizedMimeType.includes('wav')) {
      return 'wav';
    }

    if (normalizedMimeType.includes('webm')) {
      return 'webm';
    }

    return null;
  }

  private getAudioExtension(mimeType: string): string {
    const normalizedMimeType = mimeType.toLowerCase();

    if (normalizedMimeType.includes('ogg')) {
      return 'ogg';
    }

    if (normalizedMimeType.includes('opus')) {
      return 'opus';
    }

    return 'audio';
  }

  private extractMessageEnvelopes(
    payload: WhatsappWebhookPayload,
  ): WhatsappMessageEnvelope[] {
    const envelopes: WhatsappMessageEnvelope[] = [];

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        const phoneNumberId = change.value?.metadata?.phone_number_id;

        for (const message of messages) {
          envelopes.push({ message, phoneNumberId });
        }
      }
    }

    return envelopes;
  }

  private async getConversationHistory(userId: string): Promise<BaseMessage[]> {
    if (!userId) {
      return [];
    }

    if (!this.conversationStore) {
      return this.conversations.get(userId) ?? [];
    }

    try {
      const history = await this.conversationStore.findLatestMessages(
        userId,
        MAX_CONVERSATION_MESSAGES,
      );

      return history.map((message) => {
        return message.role === CONVERSATION_ROLE.USER
          ? new HumanMessage(message.content)
          : new AIMessage(message.content);
      });
    } catch (error) {
      this.logger.warn(
        `Failed to load conversation history for ${userId}; using in-memory history`,
        error instanceof Error ? error.stack : String(error),
      );

      return this.conversations.get(userId) ?? [];
    }
  }

  private async saveConversationTurn(
    userId: string,
    userText: string,
    assistantText: string,
    needsHumanAttention = false,
    attentionReason: string | null = null,
  ): Promise<void> {
    if (!userId) {
      return;
    }

    this.saveConversationTurnInMemory(userId, userText, assistantText);

    if (!this.conversationStore) {
      return;
    }

    try {
      await this.conversationStore.saveTurn(
        userId,
        userText,
        assistantText,
        needsHumanAttention,
        attentionReason,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to save conversation history for ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private saveConversationTurnInMemory(
    userId: string,
    userText: string,
    assistantText: string,
  ): void {
    const history = this.conversations.get(userId) ?? [];
    history.push(new HumanMessage(userText), new AIMessage(assistantText));
    this.conversations.set(userId, history.slice(-MAX_CONVERSATION_MESSAGES));
  }

  private rememberProcessedMessage(messageId: string): void {
    this.processedMessageIds.add(messageId);
    this.processedMessageOrder.push(messageId);

    while (this.processedMessageOrder.length > 500) {
      const oldestMessageId = this.processedMessageOrder.shift();

      if (oldestMessageId) {
        this.processedMessageIds.delete(oldestMessageId);
      }
    }
  }

  private getRequiredConfig(keys: string[]): string {
    for (const key of keys) {
      const value = this.configService.get<string>(key)?.trim();

      if (value) {
        return value;
      }
    }

    throw new InternalServerErrorException(
      `Missing required configuration: ${keys.join(' or ')}`,
    );
  }

  private contentToText(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part.type === 'text' && 'text' in part) {
          return String(part.text);
        }

        return '';
      })
      .join('')
      .trim();
  }

  private limitWhatsappText(text: string): string {
    return text.length <= 4096 ? text : `${text.slice(0, 4093)}...`;
  }

  /**
   * Turns the Markdown-flavoured text the model produces into WhatsApp-native
   * formatting. WhatsApp bold/italic/strikethrough use a single marker
   * (`*bold*`, `_italic_`, `~strike~`); anything else — `**double asterisks**`,
   * `` `code` ``, fancy bullet glyphs — is shown to the customer as literal
   * characters. We convert what maps cleanly to a single marker and strip
   * whatever is left over, so the customer sees real bold text and never a
   * stray formatting symbol. Malformed or unbalanced markup is removed rather
   * than passed through: clean plain text beats a visible `*`.
   */
  private formatForWhatsapp(text: string): string {
    if (!text) {
      return text;
    }

    // Shield URLs from every transform below: they legitimately contain `_`,
    // `~` and `*`, and rewriting those would break the link.
    const urls: string[] = [];
    const guarded = text.replace(/https?:\/\/\S+/g, (url) => {
      urls.push(url);
      return ` U${urls.length - 1} `;
    });

    const withBullets = this.normalizeListMarkers(guarded);
    const converted = this.convertMarkdownToWhatsapp(withBullets);
    const cleaned = this.stripStrayFormatting(converted);

    return cleaned.replace(
      / U(\d+) /g,
      (_match, index: string) => urls[Number(index)],
    );
  }

  private normalizeListMarkers(text: string): string {
    return (
      text
        // A model writing JSON sometimes escapes its newlines twice, so the
        // reply arrives carrying the two characters \ and n rather than a line
        // break, and WhatsApp prints them literally. Nothing a customer types
        // about lingerie contains "\n", so reading it as the newline the model
        // meant is safe.
        .replace(/\\r\\n|\\n/g, '\n')
        .replace(/\\t/g, ' ')
        .replace(/\r\n/g, '\n')
        // Drop zero-width and word-joiner characters that ride along with the
        // fancy bullet glyphs some sources paste in (e.g. "•⁠ ⁠").
        .replace(/[​-‍⁠﻿]/g, '')
        // Non-breaking spaces become ordinary spaces.
        .replace(/ /g, ' ')
        // Any bullet glyph (or a Markdown "* "/"+ " list marker) at the start
        // of a line becomes a plain hyphen list marker.
        .replace(/^[ \t]*[•▪◦‣·●○*+]\s+/gm, '- ')
    );
  }

  private convertMarkdownToWhatsapp(text: string): string {
    return (
      text
        // Markdown heading markers ("### Title" -> "Title").
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        // Bold: **text** or __text__ -> *text*
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '*$1*')
        .replace(/__(\S(?:.*?\S)?)__/g, '*$1*')
        // Strikethrough: ~~text~~ -> ~text~
        .replace(/~~(\S(?:.*?\S)?)~~/g, '~$1~')
        // Inline code / code fences: drop the backticks, keep the text.
        .replace(/`+/g, '')
    );
  }

  private stripStrayFormatting(text: string): string {
    // Any `**` still present is unbalanced Markdown the conversion could not
    // pair up; remove it so the customer never sees the asterisks.
    let result = text.replace(/\*\*/g, '');

    for (const marker of ['*', '_', '~']) {
      result = this.removeUnbalancedMarker(result, marker);
    }

    return result
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+$/gm, '');
  }

  /**
   * Keeps only balanced, text-hugging emphasis pairs for a marker (such as
   * `*bold*`) and removes every other occurrence, so a lone or malformed marker
   * is sent as clean plain text instead of a visible symbol.
   */
  private removeUnbalancedMarker(text: string, marker: string): string {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pairPattern = new RegExp(
      `${escaped}(\\S(?:[^${escaped}\\n]*\\S)?)${escaped}`,
      'g',
    );
    const kept: string[] = [];
    const withoutPairs = text.replace(pairPattern, (_match, content: string) => {
      kept.push(content);
      return ` E${kept.length - 1} `;
    });
    const stripped = withoutPairs.split(marker).join('');

    return stripped.replace(
      / E(\d+) /g,
      (_match, index: string) => `${marker}${kept[Number(index)]}${marker}`,
    );
  }
}
