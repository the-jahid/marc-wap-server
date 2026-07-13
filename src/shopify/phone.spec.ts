import { normalizePhone, phonesMatch } from './phone';

describe('normalizePhone', () => {
  it('keeps a number that already carries the country code', () => {
    expect(normalizePhone('+34612345678')).toBe('34612345678');
    expect(normalizePhone('34612345678')).toBe('34612345678');
  });

  it('adds the country code to a bare national number', () => {
    expect(normalizePhone('612345678')).toBe('34612345678');
    expect(normalizePhone('912345678')).toBe('34912345678');
  });

  it('strips formatting', () => {
    expect(normalizePhone('+34 612 34 56 78')).toBe('34612345678');
    expect(normalizePhone('(+34) 612-345-678')).toBe('34612345678');
  });

  it('unwraps the longhand international prefix', () => {
    expect(normalizePhone('0034612345678')).toBe('34612345678');
  });

  it('returns null for empty input', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });

  it('leaves a foreign number alone rather than forcing a country code', () => {
    expect(normalizePhone('+33612345678')).toBe('33612345678');
  });
});

describe('phonesMatch', () => {
  it('matches the two shapes Shopify actually stores', () => {
    // The whole point: WhatsApp sends 34XXXXXXXXX, Shopify stores both of these.
    expect(phonesMatch('34612345678', '+34612345678')).toBe(true);
    expect(phonesMatch('34612345678', '612345678')).toBe(true);
  });

  it('does not match different numbers', () => {
    expect(phonesMatch('34612345678', '34698765432')).toBe(false);
  });

  it('never matches on missing data', () => {
    expect(phonesMatch('34612345678', null)).toBe(false);
    expect(phonesMatch(null, null)).toBe(false);
    expect(phonesMatch('', '')).toBe(false);
  });
});
