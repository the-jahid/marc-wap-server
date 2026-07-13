import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { phonesMatch } from './phone';
import { summarizeVariants } from './variants';
import type {
  CustomerOrder,
  OrdersPage,
  ProductMatch,
  ProductSearchPage,
} from './shopify.types';

const DEFAULT_API_VERSION = '2025-01';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ORDERS_PER_PAGE = 250;
const MAX_ORDERS_SCANNED = 1000;
const MAX_ORDERS_RETURNED = 5;
const MAX_PRODUCTS_RETURNED = 3;
const MAX_VARIANTS_PER_PRODUCT = 250;
const MAX_DESCRIPTION_CHARS = 300;

const PRODUCT_SEARCH_QUERY = `
  query SearchProducts($query: String!, $first: Int!, $variants: Int!) {
    products(first: $first, query: $query) {
      edges {
        node {
          title
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
   * Products matching a free-text query, via the public Storefront API.
   *
   * Shopify's product search is keyword-based, not semantic: "sujetador sin
   * aros" happily returns bras *con* aros, because it matches "sujetador" and
   * ignores the negation. Callers must treat these as candidates to be checked
   * against the customer's request, not as answers.
   */
  async searchProducts(query: string): Promise<ProductMatch[]> {
    const page = await this.storefrontGraphql<ProductSearchPage>(
      PRODUCT_SEARCH_QUERY,
      {
        query,
        first: MAX_PRODUCTS_RETURNED,
        variants: MAX_VARIANTS_PER_PRODUCT,
      },
    );

    return page.products.edges.map(({ node }) => ({
      title: node.title,
      url: node.onlineStoreUrl,
      price: `${node.priceRange.minVariantPrice.amount} ${node.priceRange.minVariantPrice.currencyCode}`,
      description: this.trimDescription(node.description),
      sizes: summarizeVariants(
        node.variants.edges.map(({ node: variant }) => variant),
      ),
    }));
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
