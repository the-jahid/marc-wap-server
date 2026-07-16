import { ConfigService } from '@nestjs/config';
import { ShopifyService } from './shopify.service';
import type { OrderNode, ProductSearchPage } from './shopify.types';

type ProductNode = ProductSearchPage['products']['edges'][number]['node'];
type ProductSearchRequest = {
  variables: { query: string; first: number; after: string | null };
};

const product = (
  title: string,
  options: { name: string; value: string }[] = [],
): ProductNode => ({
  title,
  productType: '',
  tags: [],
  options: [],
  description: '',
  onlineStoreUrl: null,
  priceRange: { minVariantPrice: { amount: '29.99', currencyCode: 'EUR' } },
  variants: {
    edges: [{ node: { availableForSale: true, selectedOptions: options } }],
  },
});

const storefrontResponse = (
  products: ProductSearchPage['products'],
): Response =>
  ({
    ok: true,
    json: () => Promise.resolve({ data: { products } }),
  }) as Response;

describe('ShopifyService product family search', () => {
  const fetchMock = jest.fn<typeof fetch>();

  const requestAt = (index = 0): ProductSearchRequest => {
    const calls = fetchMock.mock.calls as unknown as [
      RequestInfo | URL,
      RequestInit?,
    ][];
    const body = calls[index]?.[1]?.body;
    if (typeof body !== 'string') {
      throw new Error(`Expected request ${index} to have a JSON body`);
    }

    const parsed: unknown = JSON.parse(body);
    return parsed as ProductSearchRequest;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      storefrontResponse({
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          { node: product('SUJETADOR HAVANNA BLUE') },
          {
            node: product('SUJETADOR HAVANNA', [
              { name: 'Color', value: 'BEIGE' },
              { name: 'Color', value: 'CRISTAL' },
            ]),
          },
          { node: product('SUJETADOR HAVANNA PINK') },
          { node: product('BRA HAVANNA RED') },
          { node: product('BRAGA HAVANNA BLACK') },
        ],
      }),
    );
    global.fetch = fetchMock;
  });

  it('searches the style instead of an exact colour/title and excludes panties', async () => {
    const config = new ConfigService({
      SHOPIFY_STORE: 'shop.myshopify.com',
      SHOPIFY_STOREFRONT_TOKEN: 'token',
    });
    const service = new ShopifyService(config);

    await expect(
      service.searchProducts('Do you have the Havanna bra in other colors?'),
    ).resolves.toMatchObject({
      model: 'Havanna',
      requestedType: 'bra',
      colors: ['BLUE', 'BEIGE', 'CRISTAL', 'PINK', 'RED'],
      matches: [
        { title: 'SUJETADOR HAVANNA BLUE', garmentType: 'bra' },
        { title: 'SUJETADOR HAVANNA', garmentType: 'bra' },
        { title: 'SUJETADOR HAVANNA PINK', garmentType: 'bra' },
        { title: 'BRA HAVANNA RED', garmentType: 'bra' },
      ],
    });

    const request = requestAt();
    expect(request.variables).toMatchObject({
      query: 'title:"Havanna"',
      first: 100,
      after: null,
    });
  });

  it('removes Spanish colour-question words from the model search', async () => {
    const config = new ConfigService({
      SHOPIFY_STORE: 'shop.myshopify.com',
      SHOPIFY_STOREFRONT_TOKEN: 'token',
    });
    const service = new ShopifyService(config);

    await service.searchProducts(
      '¿Tenéis el sujetador Havanna en otros colores?',
    );

    const request = requestAt();
    expect(request.variables.query).toBe('title:"Havanna"');
  });

  it('removes French colour-question words from the model search', async () => {
    const config = new ConfigService({
      SHOPIFY_STORE: 'shop.myshopify.com',
      SHOPIFY_STOREFRONT_TOKEN: 'token',
    });
    const service = new ShopifyService(config);

    await service.searchProducts(
      "Avez-vous le soutien-gorge Havanna dans d'autres couleurs ?",
    );

    const request = requestAt();
    expect(request.variables.query).toBe('title:"Havanna"');
  });

  it('paginates through the whole style family before filtering and aggregating colours', async () => {
    fetchMock
      .mockResolvedValueOnce(
        storefrontResponse({
          pageInfo: { hasNextPage: true, endCursor: 'page-2' },
          edges: [{ node: product('SUJETADOR HAVANNA BLUE') }],
        }),
      )
      .mockResolvedValueOnce(
        storefrontResponse({
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            { node: product('BRA HAVANNA BEIGE') },
            { node: product('BRAGA HAVANNA RED') },
          ],
        }),
      );

    const config = new ConfigService({
      SHOPIFY_STORE: 'shop.myshopify.com',
      SHOPIFY_STOREFRONT_TOKEN: 'token',
    });
    const service = new ShopifyService(config);

    await expect(
      service.searchProducts('Havanna bra colours'),
    ).resolves.toMatchObject({
      colors: ['BLUE', 'BEIGE'],
      matches: [
        { title: 'SUJETADOR HAVANNA BLUE' },
        { title: 'BRA HAVANNA BEIGE' },
      ],
    });

    const secondRequest = requestAt(1);
    expect(secondRequest.variables.after).toBe('page-2');
  });
});

const orderNode = (overrides: Partial<OrderNode> = {}): OrderNode => ({
  name: '#4054',
  createdAt: '2026-07-01T10:00:00.000Z',
  email: null,
  phone: null,
  displayFulfillmentStatus: 'FULFILLED',
  displayFinancialStatus: 'PAID',
  totalPriceSet: { shopMoney: { amount: '59.90', currencyCode: 'EUR' } },
  customer: null,
  shippingAddress: null,
  billingAddress: null,
  lineItems: { edges: [{ node: { title: 'SUJETADOR HAVANNA', quantity: 1 } }] },
  fulfillments: [],
  ...overrides,
});

const tokenResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ access_token: 'admin-token', expires_in: 86_400 }),
  }) as Response;

const ordersResponse = (nodes: OrderNode[], hasNextPage = false): Response =>
  ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: {
          orders: {
            pageInfo: { hasNextPage, endCursor: 'next-page' },
            edges: nodes.map((node) => ({ node })),
          },
        },
      }),
  }) as Response;

describe('ShopifyService order lookup', () => {
  const fetchMock = jest.fn();

  const adminService = (): ShopifyService =>
    new ShopifyService(
      new ConfigService({
        SHOPIFY_STORE: 'shop.myshopify.com',
        SHOPIFY_CLIENT_ID: 'client-id',
        SHOPIFY_CLIENT_SECRET: 'client-secret',
      }),
    );

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  // The bug this whole feature exists to fix: the customer is messaging from a
  // number the order was never placed with, but they know their order number.
  it('finds an order by number when it was placed with another phone', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        ordersResponse([orderNode({ name: '#4054', phone: '+34600111222' })]),
      );

    await expect(
      adminService().findOrders({
        orderNumber: '4054',
        phone: '34699888777',
      }),
    ).resolves.toMatchObject([
      { name: '#4054', fulfillmentStatus: 'FULFILLED' },
    ]);
  });

  it.each([['4054'], ['#4054'], ['no. 4054'], ['pedido 4054']])(
    'resolves order number written as "%s"',
    async (written) => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(ordersResponse([orderNode({ name: '#4054' })]));

      await expect(
        adminService().findOrders({ orderNumber: written }),
      ).resolves.toMatchObject([{ name: '#4054' }]);
    },
  );

  /**
   * Shopify answers an unrecognised search key with the shop's most recent
   * orders rather than an empty result, so a trusted server-side filter would
   * hand a stranger's order to whoever asked.
   */
  it('never returns an order Shopify offered that does not match the identifier', async () => {
    const unrelated = [
      orderNode({ name: '#9001' }),
      orderNode({ name: '#9002' }),
    ];

    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(ordersResponse(unrelated))
      .mockResolvedValueOnce(ordersResponse(unrelated));

    await expect(
      adminService().findOrders({ orderNumber: '4054' }),
    ).resolves.toEqual([]);
  });

  it('finds an order by email, case- and space-insensitively', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        ordersResponse([orderNode({ email: 'Maria@Example.com' })]),
      );

    await expect(
      adminService().findOrders({ email: '  maria@example.com ' }),
    ).resolves.toMatchObject([{ name: '#4054' }]);
  });

  it('finds an order by tracking number by scanning, ignoring separators', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
      ordersResponse([
        orderNode({
          fulfillments: [
            { trackingInfo: [{ number: 'ES-1234-5678', company: 'SEUR' }] },
          ],
        }),
      ]),
    );

    await expect(
      adminService().findOrders({ trackingNumber: 'es12345678' }),
    ).resolves.toMatchObject([{ name: '#4054' }]);
  });

  it('finds an order by full name regardless of accents or casing', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        ordersResponse([
          orderNode({ shippingAddress: { name: 'María García', phone: null } }),
        ]),
      );

    await expect(
      adminService().findOrders({ customerName: 'maria garcia' }),
    ).resolves.toMatchObject([{ name: '#4054' }]);
  });

  // A first name matches half the shop; only the whole name identifies an order.
  it('does not match a full name on a first name alone', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        ordersResponse([
          orderNode({ shippingAddress: { name: 'María García', phone: null } }),
        ]),
      );

    await expect(
      adminService().findOrders({ customerName: 'María' }),
    ).resolves.toEqual([]);
  });

  it('still matches the national/E.164 phone shapes the shop stores', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        ordersResponse([
          orderNode({ shippingAddress: { name: null, phone: '600111222' } }),
        ]),
      );

    await expect(
      adminService().findOrdersForPhone('34600111222'),
    ).resolves.toMatchObject([{ name: '#4054' }]);
  });

  it('returns nothing when no identifier is usable rather than scanning the shop', async () => {
    await expect(
      adminService().findOrders({ orderNumber: '   ', email: null }),
    ).resolves.toEqual([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
