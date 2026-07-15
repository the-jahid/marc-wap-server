import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizePhone, phonesMatch } from './phone';
import { summarizeVariants } from './variants';
import {
  canonicalGarmentType,
  classifyGarmentType,
  extractColors,
} from './products';
import type {
  AbandonedCheckout,
  AbandonedCheckoutsPage,
  CustomerOrder,
  OrdersPage,
  ProductMatch,
  ProductSearchResult,
  ProductSearchPage,
} from './shopify.types';

const DEFAULT_API_VERSION = '2025-01';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ORDERS_PER_PAGE = 250;
const MAX_ORDERS_SCANNED = 1000;
const MAX_ORDERS_RETURNED = 5;
// A colour/style question must consider the whole product family, including
// families that span more than one Storefront API page.
const PRODUCTS_PER_PAGE = 100;
const MAX_VARIANTS_PER_PRODUCT = 250;
const MAX_DESCRIPTION_CHARS = 300;
const ABANDONED_CHECKOUTS_PER_PAGE = 100;
const MAX_ABANDONED_CHECKOUTS_SCANNED = 500;
const MAX_ABANDONED_CHECKOUTS_RETURNED = 100;

const PRODUCT_SEARCH_QUERY = `
  query SearchProducts(
    $query: String!
    $first: Int!
    $after: String
    $variants: Int!
  ) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          productType
          tags
          options { name values }
          description
          onlineStoreUrl
          priceRange { minVariantPrice { amount currencyCode } }
          variants(first: $variants) {
            edges {
              node {
                availableForSale
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query RecentOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          name
          createdAt
          phone
          displayFulfillmentStatus
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { phone }
          shippingAddress { phone }
          lineItems(first: 10) {
            edges { node { title quantity } }
          }
          fulfillments(first: 5) {
            trackingInfo { number company url }
          }
        }
      }
    }
  }
`;

const ABANDONED_CHECKOUTS_QUERY = `
  query AbandonedCheckouts($first: Int!, $after: String) {
    abandonedCheckouts(
      first: $first
      after: $after
      sortKey: CREATED_AT
      reverse: true
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          completedAt
          abandonedCheckoutUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName phone email }
          billingAddress { phone }
          shippingAddress { phone }
          lineItems(first: 10) {
            edges { node { title quantity } }
          }
        }
      }
    }
  }
`;

type ClientCredentialsResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

type CachedToken = {
  token: string;
  expiresAt: number;
};

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);
  private cachedToken?: CachedToken;
  private pendingToken?: Promise<string>;

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('SHOPIFY_STORE')?.trim() &&
      this.configService.get<string>('SHOPIFY_CLIENT_ID')?.trim() &&
      this.configService.get<string>('SHOPIFY_CLIENT_SECRET')?.trim(),
    );
  }

  canSearchProducts(): boolean {
    return Boolean(
      this.configService.get<string>('SHOPIFY_STORE')?.trim() &&
      this.configService.get<string>('SHOPIFY_STOREFRONT_TOKEN')?.trim(),
    );
  }

  /**
   * Finds every published, active product in a named style family, then applies
   * the garment filter locally.  The local filter is intentional: title is the
   * only consistently populated classification field in this catalogue, while
   * product type and tags are useful fallbacks.
   */
  async searchProducts(query: string): Promise<ProductSearchResult> {
    const model = this.extractModel(query);
    const requestedType = canonicalGarmentType(query);
    const products = await this.findProductFamily(model);

    const family = products
      .map(({ node }) => {
        // Read product-level options as well as variant selections. The former
        // is the canonical list of colour values; the latter protects us from
        // imperfect catalogues where a value only appears on a variant.
        const options = new Map(
          node.options.map((option) => [option.name, new Set(option.values)]),
        );
        for (const { node: variant } of node.variants.edges) {
          for (const option of variant.selectedOptions) {
            const values = options.get(option.name) ?? new Set<string>();
            values.add(option.value);
            options.set(option.name, values);
          }
        }

        const optionsForColors = [...options].map(([name, values]) => ({
          name,
          values: [...values],
        }));

        return {
          title: node.title,
          url: node.onlineStoreUrl,
          price: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
          description: this.trimDescription(node.description),
          sizes: summarizeVariants(
            node.variants.edges.map(({ node: variant }) => variant),
          ),
          colors: extractColors(node.title, optionsForColors),
          garmentType: classifyGarmentType(
            node.title,
            node.productType,
            node.tags,
          ),
        } satisfies ProductMatch;
      })
      // Shopify keyword matching can return a related product without the
      // style in its title. The requested model is a hard requirement.
      .filter((product) =>
        this.normalizeSearchText(product.title).includes(
          this.normalizeSearchText(model),
        ),
      );

    // Never substitute matching panties (or another related garment) when a
    // customer explicitly asked for bras. An empty result is more truthful.
    const matches = requestedType
      ? family.filter((product) => product.garmentType === requestedType)
      : family;

    return {
      model,
      requestedType,
      matches,
      colors: this.uniqueColors(matches.flatMap((product) => product.colors)),
      broadened: false,
    };
  }

  /**
   * Fetches the complete model/style family. The remote query deliberately
   * contains only the style name: garment and colour words would hide sibling
   * products whose catalogue metadata differs.
   */
  private async findProductFamily(
    model: string,
  ): Promise<ProductSearchPage['products']['edges']> {
    const edges: ProductSearchPage['products']['edges'] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;

    while (true) {
      const page: ProductSearchPage =
        await this.storefrontGraphql<ProductSearchPage>(PRODUCT_SEARCH_QUERY, {
          // Storefront automatically excludes draft, archived and unpublished
          // products from this connection.
          query: `title:${this.quoteSearchTerm(model)}`,
          first: PRODUCTS_PER_PAGE,
          after,
          variants: MAX_VARIANTS_PER_PRODUCT,
        });

      edges.push(...page.products.edges);

      const { hasNextPage, endCursor } = page.products.pageInfo;
      if (!hasNextPage || !endCursor || seenCursors.has(endCursor)) {
        break;
      }

      seenCursors.add(endCursor);
      after = endCursor;
    }

    return edges;
  }

  private extractModel(query: string): string {
    const ignoredWords = new Set([
      // Garments: the style search is intentionally broader than the final
      // local garment filter.
      'bra',
      'bras',
      'sujetador',
      'sujetadores',
      'brasier',
      'bralette',
      'soutien',
      'gorge',
      'reggiseno',
      'panty',
      'panties',
      'braga',
      'bragas',
      'braguita',
      'braguitas',
      'tanga',
      'tangas',
      'culotte',
      'culottes',
      'brief',
      'briefs',
      'body',
      'bodysuit',
      'faja',
      'fajas',
      'shaper',
      'shapewear',
      'set',
      'conjunto',
      'conjuntos',
      // English colour/style question words.
      'do',
      'does',
      'you',
      'have',
      'the',
      'a',
      'an',
      'in',
      'other',
      'different',
      'color',
      'colors',
      'colour',
      'colours',
      'model',
      'style',
      'available',
      'which',
      'what',
      'any',
      'come',
      'comes',
      'is',
      'are',
      // Spanish colour/style question words (tokens are accent-normalized).
      'que',
      'hay',
      'teneis',
      'tienes',
      'tiene',
      'tienen',
      'en',
      'el',
      'la',
      'los',
      'las',
      'de',
      'del',
      'otro',
      'otros',
      'otra',
      'otras',
      'diferente',
      'diferentes',
      'color',
      'colores',
      'modelo',
      'estilo',
      'disponible',
      'disponibles',
      'esta',
      'estan',
      'viene',
      'vienen',
      // French colour/style question words.
      'avez',
      'vous',
      'as',
      'tu',
      'le',
      'les',
      'un',
      'une',
      'des',
      'du',
      'd',
      'dans',
      'autre',
      'autres',
      'different',
      'differents',
      'differente',
      'differentes',
      'couleur',
      'couleurs',
      'modele',
      'est',
      'sont',
      'existe',
    ]);

    const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    const withoutGarment = words
      .filter((word) => !ignoredWords.has(this.normalizeSearchText(word)))
      .join(' ')
      .trim();

    // The model normally passes only the product words. If it did not, keep
    // the original input rather than issuing an empty, store-wide query.
    return withoutGarment || query.trim();
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .toLocaleLowerCase()
      .trim();
  }

  private quoteSearchTerm(value: string): string {
    return `"${value.replace(/["\\]/g, '\\$&')}"`;
  }

  private uniqueColors(colors: string[]): string[] {
    const seen = new Set<string>();
    return colors.filter((color) => {
      const key = color
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private trimDescription(description: string): string {
    const collapsed = description.replace(/\s+/g, ' ').trim();

    return collapsed.length <= MAX_DESCRIPTION_CHARS
      ? collapsed
      : `${collapsed.slice(0, MAX_DESCRIPTION_CHARS)}...`;
  }

  private async storefrontGraphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const store = this.getRequiredConfig('SHOPIFY_STORE');
    const token = this.getRequiredConfig('SHOPIFY_STOREFRONT_TOKEN');
    const apiVersion =
      this.configService.get<string>('SHOPIFY_API_VERSION')?.trim() ||
      DEFAULT_API_VERSION;

    const response = await fetch(
      `https://${store}/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Storefront-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new InternalServerErrorException(
        `Shopify Storefront API failed with HTTP ${response.status}: ${body}`,
      );
    }

    const payload = (await response.json()) as GraphqlResponse<T>;

    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).join('; ');
      throw new InternalServerErrorException(
        `Shopify Storefront API: ${message}`,
      );
    }

    if (!payload.data) {
      throw new InternalServerErrorException(
        'Shopify Storefront API returned no data',
      );
    }

    return payload.data;
  }

  /**
   * Orders belonging to `customerPhone`, newest first.
   *
   * The caller must pass the phone number WhatsApp reported as the sender.
   * Never pass a number the customer typed, or one a language model produced
   * from the message text: either would let anyone read a stranger's orders.
   *
   * Matching happens here rather than in the Shopify query on purpose.
   * Shopify's order search silently ignores an unrecognised `phone:` key and
   * returns the most recent orders in the shop instead of an empty result, so
   * a server-side filter would hand the wrong customer's order to whoever asked.
   */
  async findOrdersForPhone(customerPhone: string): Promise<CustomerOrder[]> {
    const matches: CustomerOrder[] = [];
    let cursor: string | undefined;
    let scanned = 0;

    while (scanned < MAX_ORDERS_SCANNED) {
      const page = await this.adminGraphql<OrdersPage>(ORDERS_QUERY, {
        first: ORDERS_PER_PAGE,
        after: cursor ?? null,
      });

      for (const { node } of page.orders.edges) {
        scanned += 1;

        const belongsToCustomer =
          phonesMatch(customerPhone, node.shippingAddress?.phone) ||
          phonesMatch(customerPhone, node.phone) ||
          phonesMatch(customerPhone, node.customer?.phone);

        if (!belongsToCustomer) {
          continue;
        }

        matches.push({
          name: node.name,
          createdAt: node.createdAt,
          fulfillmentStatus: node.displayFulfillmentStatus,
          financialStatus: node.displayFinancialStatus,
          total: `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`,
          items: node.lineItems.edges.map(({ node: item }) => ({
            title: item.title,
            quantity: item.quantity,
          })),
          tracking: node.fulfillments.flatMap((fulfillment) =>
            fulfillment.trackingInfo.map((info) => ({
              number: info.number ?? null,
              company: info.company ?? null,
              url: info.url ?? null,
            })),
          ),
        });

        if (matches.length >= MAX_ORDERS_RETURNED) {
          return matches;
        }
      }

      if (!page.orders.pageInfo.hasNextPage) {
        break;
      }

      cursor = page.orders.pageInfo.endCursor;
    }

    return matches;
  }

  /**
   * Recently abandoned checkouts, newest first, aged into a recovery window.
   *
   * Only checkouts whose age is between `delayMs` (they have had time to be
   * abandoned) and `lookbackMs` (recent enough to still be worth chasing) are
   * returned. `completedAt` is left on each result so the caller can make the
   * "the order has not been completed" check itself; a checkout that later
   * turned into a paid order still appears here with `completedAt` set.
   *
   * Results are sorted newest first, so paging stops as soon as a checkout is
   * older than the lookback window rather than walking the whole history.
   */
  async findRecentAbandonedCheckouts(options: {
    delayMs: number;
    lookbackMs: number;
    now?: number;
  }): Promise<AbandonedCheckout[]> {
    const now = options.now ?? Date.now();
    const oldestAllowed = now - options.lookbackMs;
    const newestAllowed = now - options.delayMs;

    const matches: AbandonedCheckout[] = [];
    let cursor: string | undefined;
    let scanned = 0;

    while (scanned < MAX_ABANDONED_CHECKOUTS_SCANNED) {
      const page = await this.adminGraphql<AbandonedCheckoutsPage>(
        ABANDONED_CHECKOUTS_QUERY,
        {
          first: ABANDONED_CHECKOUTS_PER_PAGE,
          after: cursor ?? null,
        },
      );

      for (const { node } of page.abandonedCheckouts.edges) {
        scanned += 1;

        const createdAtMs = Date.parse(node.createdAt);

        // Newest first: once we reach a checkout older than the window, every
        // remaining checkout is older too, so we can stop entirely.
        if (Number.isFinite(createdAtMs) && createdAtMs < oldestAllowed) {
          return matches;
        }

        // Too fresh to have been abandoned yet; skip but keep scanning older ones.
        if (Number.isFinite(createdAtMs) && createdAtMs > newestAllowed) {
          continue;
        }

        matches.push(this.toAbandonedCheckout(node));

        if (matches.length >= MAX_ABANDONED_CHECKOUTS_RETURNED) {
          return matches;
        }
      }

      if (!page.abandonedCheckouts.pageInfo.hasNextPage) {
        break;
      }

      cursor = page.abandonedCheckouts.pageInfo.endCursor ?? undefined;

      if (!cursor) {
        break;
      }
    }

    return matches;
  }

  private toAbandonedCheckout(
    node: AbandonedCheckoutsPage['abandonedCheckouts']['edges'][number]['node'],
  ): AbandonedCheckout {
    const rawPhone =
      node.customer?.phone ??
      node.shippingAddress?.phone ??
      node.billingAddress?.phone ??
      null;

    return {
      id: node.id,
      createdAt: node.createdAt,
      completedAt: node.completedAt ?? null,
      recoveryUrl: node.abandonedCheckoutUrl ?? null,
      customerFirstName: node.customer?.firstName ?? null,
      email: node.customer?.email?.trim() || null,
      phone: normalizePhone(rawPhone),
      total: `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`,
      items: node.lineItems.edges.map(({ node: item }) => ({
        title: item.title,
        quantity: item.quantity,
      })),
    };
  }

  async adminGraphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const store = this.getRequiredConfig('SHOPIFY_STORE');
    const apiVersion =
      this.configService.get<string>('SHOPIFY_API_VERSION')?.trim() ||
      DEFAULT_API_VERSION;
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://${store}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    if (response.status === 401) {
      this.cachedToken = undefined;
      throw new InternalServerErrorException(
        'Shopify rejected the Admin API token',
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new InternalServerErrorException(
        `Shopify Admin API failed with HTTP ${response.status}: ${body}`,
      );
    }

    const payload = (await response.json()) as GraphqlResponse<T>;

    if (payload.errors?.length) {
      const message = payload.errors.map((error) => error.message).join('; ');
      throw new InternalServerErrorException(`Shopify Admin API: ${message}`);
    }

    if (!payload.data) {
      throw new InternalServerErrorException(
        'Shopify Admin API returned no data',
      );
    }

    return payload.data;
  }

  /**
   * The client credentials grant returns a token that expires in ~24h, so it is
   * held in memory and re-minted on demand rather than stored in configuration.
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token;
    }

    // Collapse concurrent refreshes so a burst of webhooks mints a single token.
    this.pendingToken ??= this.requestAccessToken().finally(() => {
      this.pendingToken = undefined;
    });

    return this.pendingToken;
  }

  private async requestAccessToken(): Promise<string> {
    const store = this.getRequiredConfig('SHOPIFY_STORE');
    const clientId = this.getRequiredConfig('SHOPIFY_CLIENT_ID');
    const clientSecret = this.getRequiredConfig('SHOPIFY_CLIENT_SECRET');

    const response = await fetch(`https://${store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new InternalServerErrorException(
        `Shopify token exchange failed with HTTP ${response.status}: ${body}`,
      );
    }

    const payload = (await response.json()) as ClientCredentialsResponse;

    if (!payload.access_token) {
      throw new InternalServerErrorException(
        'Shopify token exchange returned no access_token',
      );
    }

    const expiresInMs = (payload.expires_in ?? 86_400) * 1000;
    this.cachedToken = {
      token: payload.access_token,
      expiresAt: Date.now() + expiresInMs - TOKEN_REFRESH_MARGIN_MS,
    };

    this.logger.log(
      `Shopify Admin token acquired (scopes: ${payload.scope ?? 'unknown'})`,
    );

    return payload.access_token;
  }

  private getRequiredConfig(key: string): string {
    const value = this.configService.get<string>(key)?.trim();

    if (!value) {
      throw new InternalServerErrorException(
        `Missing required configuration: ${key}`,
      );
    }

    return value;
  }
}
