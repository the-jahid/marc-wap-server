const DEFAULT_COUNTRY_CODE = '34';
const NATIONAL_NUMBER_LENGTH = 9;
const SPANISH_SUBSCRIBER_PREFIX = /^[6789]/;

/**
 * Shopify stores this shop's phones in two shapes: most as `+34XXXXXXXXX`, but
 * a sizeable minority as a bare 9-digit national number with no country code.
 * WhatsApp delivers the sender as `34XXXXXXXXX`. Comparing any of these as
 * strings silently fails to match a real customer, so both sides of every
 * comparison must pass through here first.
 *
 * Returns digits only, country code included, or null when the input cannot be
 * resolved to a dialable number.
 */
export function normalizePhone(
  raw: string | null | undefined,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  if (!raw) {
    return null;
  }

  let digits = raw.replace(/\D/g, '');

  if (!digits) {
    return null;
  }

  // "0034..." is the international prefix written out longhand.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (
    digits.length === NATIONAL_NUMBER_LENGTH &&
    SPANISH_SUBSCRIBER_PREFIX.test(digits)
  ) {
    return `${countryCode}${digits}`;
  }

  if (
    digits.length === countryCode.length + NATIONAL_NUMBER_LENGTH &&
    digits.startsWith(countryCode)
  ) {
    return digits;
  }

  // A foreign number, or something we do not recognise. Keep the digits so an
  // exact match is still possible, but do not invent a country code for it.
  return digits;
}

export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);

  return left !== null && right !== null && left === right;
}
