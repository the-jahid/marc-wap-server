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

  it('recognises literal bra labels in the title, product type, or tags', () => {
    expect(classifyGarmentType('BRA HAVANNA BEIGE')).toBe('bra');
    expect(classifyGarmentType('HAVANNA BEIGE', 'Bra')).toBe('bra');
    expect(classifyGarmentType('HAVANNA BEIGE', 'Bras')).toBe('bra');
    expect(classifyGarmentType('HAVANNA BEIGE', '', ['bra'])).toBe('bra');
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

  it('reads French colour option names', () => {
    expect(
      extractColors('SOUTIEN HAVANNA', [
        { name: 'Couleur', values: ['ROSE', 'ROUGE'] },
      ]),
    ).toEqual(['ROSE', 'ROUGE']);
  });
});
