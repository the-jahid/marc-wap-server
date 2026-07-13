export type OrderTracking = {
  number: string | null;
  company: string | null;
  url: string | null;
};

export type OrderItem = {
  title: string;
  quantity: number;
};

export type CustomerOrder = {
  name: string;
  createdAt: string;
  fulfillmentStatus: string;
  financialStatus: string;
  total: string;
  items: OrderItem[];
  tracking: OrderTracking[];
};

export type ProductMatch = {
  title: string;
  url: string | null;
  price: string;
  description: string;
  sizes: string;
};

export type ProductSearchPage = {
  products: {
    edges: {
      node: {
        title: string;
        description: string;
        onlineStoreUrl: string | null;
        priceRange: {
          minVariantPrice: { amount: string; currencyCode: string };
        };
        variants: {
          edges: {
            node: {
              availableForSale: boolean;
              selectedOptions: { name: string; value: string }[];
            };
          }[];
        };
      };
    }[];
  };
};

export type OrdersPage = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string };
    edges: {
      node: {
        name: string;
        createdAt: string;
        phone: string | null;
        displayFulfillmentStatus: string;
        displayFinancialStatus: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        customer: { phone: string | null } | null;
        shippingAddress: { phone: string | null } | null;
        lineItems: { edges: { node: { title: string; quantity: number } }[] };
        fulfillments: { trackingInfo: Partial<OrderTracking>[] }[];
      };
    }[];
  };
};
