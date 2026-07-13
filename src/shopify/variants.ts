export type VariantOption = { name: string; value: string };

export type Variant = {
  availableForSale: boolean;
  selectedOptions: VariantOption[];
};

/**
 * Flattens a product's variants into a compact listing of the size combinations
 * the shop actually offers, e.g. `TALLA 95: COPA C, D, E`.
 *
 * The cross product of the options is not a safe substitute: the top-selling bra
 * exposes 79 real variants out of 110 possible TALLA x COPA pairs, so deriving
 * availability by multiplying the option lists would invent sizes that cannot be
 * ordered. Only combinations that exist as a variant appear here.
 */
export function summarizeVariants(variants: Variant[]): string {
  const sellable = variants.filter((variant) => variant.availableForSale);

  if (sellable.length === 0) {
    return 'no sizes currently offered';
  }

  const [primaryOption] = sellable[0].selectedOptions;

  if (!primaryOption) {
    return 'single option product';
  }

  // A single-option product (e.g. one size) needs no grouping.
  if (sellable[0].selectedOptions.length === 1) {
    const values = unique(
      sellable.map((variant) => variant.selectedOptions[0].value),
    );

    return `${primaryOption.name}: ${values.join(', ')}`;
  }

  const grouped = new Map<string, string[]>();

  for (const variant of sellable) {
    const [primary, ...rest] = variant.selectedOptions;
    const key = `${primary.name} ${primary.value}`;
    const secondary = rest.map((option) => option.value).join('/');

    grouped.set(key, [...(grouped.get(key) ?? []), secondary]);
  }

  const secondaryName = sellable[0].selectedOptions
    .slice(1)
    .map((option) => option.name)
    .join('/');

  return [...grouped.entries()]
    .map(
      ([key, values]) =>
        `${key} -> ${secondaryName}: ${unique(values).join(', ')}`,
    )
    .join('; ');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
