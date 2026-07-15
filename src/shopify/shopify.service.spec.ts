import { ConfigService } from '@nestjs/config';
import { ShopifyService } from './shopify.service';
import type { ProductSearchPage } from './shopify.types';

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
