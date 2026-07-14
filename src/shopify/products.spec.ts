import {
  canonicalGarmentType,
  classifyGarmentType,
  extractColors,
} from './products';

describe('catalogue product helpers', () => {
  it('recognises a bra from the title before inconsistent metadata', () => {
    expect(
      classifyGarmentType('SUJETADOR HAVANNA BEIGE', 'Panties', ['braga']),
    ).toBe('bra');
  });

  it('does not mistake braga for bra in a customer request', () => {
    expect(canonicalGarmentType('braga Havanna')).toBe('panty');
    expect(canonicalGarmentType('Havanna bra')).toBe('bra');
  });

  it('combines colour variant values and title colours without duplicates', () => {
    expect(
      extractColors('SUJETADOR HAVANNA BLUE', [
        { name: 'COLOR', values: ['Blue', 'BEIGE', 'CRISTAL'] },
      ]),
    ).toEqual(['Blue', 'BEIGE', 'CRISTAL']);
  });
});
