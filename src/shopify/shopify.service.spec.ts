import { ConfigService } from '@nestjs/config';
import { ShopifyService } from './shopify.service';

const product = (
  title: string,
  options: { name: string; value: string }[] = [],
) => ({
  title,
  productType: '',
  tags: [],
  options: [],
  description: '',
  onlineStoreUrl: null,
  priceRange: { minVariantPrice: { amount: '29.99', currencyCode: 'EUR' } },
  variants: {
    edges: [
      { node: { availableForSale: true, selectedOptions: options } },
    ],
  },
});

describe('ShopifyService product family search', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          products: {
            edges: [
              { node: product('SUJETADOR HAVANNA BLUE') },
              {
                node: product('SUJETADOR HAVANNA', [
                  { name: 'Color', value: 'BEIGE' },
                  { name: 'Color', value: 'CRISTAL' },
                ]),
              },
              { node: product('BRAGA HAVANNA RED') },
            ],
          },
        },
      }),
    });
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
      colors: ['BLUE', 'BEIGE', 'CRISTAL'],
      matches: [
        { title: 'SUJETADOR HAVANNA BLUE', garmentType: 'bra' },
        { title: 'SUJETADOR HAVANNA', garmentType: 'bra' },
      ],
    });

    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(request.variables).toMatchObject({
      query: 'title:"Havanna"',
      first: 100,
    });
  });
});
