import { summarizeVariants } from './variants';
import type { Variant } from './variants';

const variant = (
  options: Record<string, string>,
  availableForSale = true,
): Variant => ({
  availableForSale,
  selectedOptions: Object.entries(options).map(([name, value]) => ({
    name,
    value,
  })),
});

describe('summarizeVariants', () => {
  it('groups the second option under the first', () => {
    const summary = summarizeVariants([
      variant({ TALLA: '95', COPA: 'C' }),
      variant({ TALLA: '95', COPA: 'D' }),
      variant({ TALLA: '100', COPA: 'E' }),
    ]);

    expect(summary).toBe('TALLA 95 -> COPA: C, D; TALLA 100 -> COPA: E');
  });

  it('only reports combinations that actually exist', () => {
    // 95/C and 100/D exist; 95/D and 100/C do not. The cross product would
    // wrongly offer all four.
    const summary = summarizeVariants([
      variant({ TALLA: '95', COPA: 'C' }),
      variant({ TALLA: '100', COPA: 'D' }),
    ]);

    expect(summary).toBe('TALLA 95 -> COPA: C; TALLA 100 -> COPA: D');
    expect(summary).not.toContain('95 -> COPA: C, D');
  });

  it('omits variants that are not for sale', () => {
    const summary = summarizeVariants([
      variant({ TALLA: '95', COPA: 'C' }),
      variant({ TALLA: '95', COPA: 'D' }, false),
    ]);

    expect(summary).toBe('TALLA 95 -> COPA: C');
  });

  it('handles a single-option product', () => {
    const summary = summarizeVariants([
      variant({ Talla: 'M' }),
      variant({ Talla: 'L' }),
    ]);

    expect(summary).toBe('Talla: M, L');
  });

  it('reports when nothing is sellable', () => {
    const summary = summarizeVariants([
      variant({ TALLA: '95', COPA: 'C' }, false),
    ]);

    expect(summary).toBe('no sizes currently offered');
  });

  it('survives an empty variant list', () => {
    expect(summarizeVariants([])).toBe('no sizes currently offered');
  });
});
