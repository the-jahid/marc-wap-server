export type ProductOption = { name: string; values: string[] };

/**
 * This shop encodes the same information in wildly inconsistent ways, so product
 * classification cannot lean on any single Shopify field:
 *
 * - Garment type lives reliably only in the TITLE ("Sujetador ...", "Braga ...",
 *   "Body ..."). `productType` is frequently empty and `tags` are sporadic, so
 *   they are only a fallback.
 * - Colour is encoded two different ways: baked into the title as a suffix
 *   ("... HAVANNA BLUE", "... BEIGE") for some models, and as a dedicated COLOR
 *   variant option ("NEGRO", "DESERT") for others. Both must be read.
 *
 * These helpers turn that mess into two clean signals — a canonical garment type
 * and a colour list — so a customer asking "does the Havanna bra come in other
 * colours?" can be answered from the whole product family, not one lucky hit.
 */

export type GarmentType = 'bra' | 'panty' | 'body' | 'shaper' | 'set';

// Combining diacritical marks block (U+0300–U+036F), removed after NFD so
// "Marrón" and "marron" compare equal. Built from code points to keep the
// source ASCII-only.
const DIACRITICS = new RegExp(
  `[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`,
  'g',
);

/** Lowercases and strips accents so "Marrón" and "marron" compare equal. */
function normalize(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS, '').toLowerCase().trim();
}

/** Matches catalogue terms as words, so `bra` never matches inside `braga`. */
function containsKeyword(value: string, keyword: string): boolean {
  const words = ` ${normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const wanted = ` ${normalize(keyword).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return words.includes(wanted);
}

// Checked against the TITLE first (the only consistent signal), then against
// productType/tags. Order matters: the first canonical type whose keyword is
// found wins, so more specific garments are listed before looser ones.
const GARMENT_TYPE_KEYWORDS: [GarmentType, string[]][] = [
  ['body', ['body']],
  ['shaper', ['faja']],
  [
    'bra',
    ['bra', 'bras', 'sujetador', 'brasier', 'bralette', 'soutien', 'reggiseno'],
  ],
  ['panty', ['braga', 'braguita', 'tanga', 'culotte', 'brief', 'panty']],
  ['set', ['conjunto']],
];

// The customer (via the model) may name the garment in any language; map those
// words onto our canonical types so "bra", "sujetador" and "soutien" all filter
// the same way.
const REQUESTED_TYPE_SYNONYMS: [GarmentType, string[]][] = [
  [
    'bra',
    ['bra', 'sujetador', 'sujetadores', 'brasier', 'soutien', 'reggiseno'],
  ],
  [
    'panty',
    [
      'panty',
      'panties',
      'braga',
      'bragas',
      'braguita',
      'tanga',
      'culotte',
      'slip',
      'brief',
      'calzon',
    ],
  ],
  ['body', ['body', 'bodysuit']],
  ['shaper', ['shaper', 'shapewear', 'faja']],
  ['set', ['set', 'conjunto']],
];

// Colour words this shop actually uses, in Spanish and the English/other labels
// that appear in titles (BLUE, CRISTAL, DESERT ...). Deliberately conservative:
// ambiguous words that double as ordinary text (e.g. "palo", "arena") are left
// out to avoid tagging a non-colour token as a colour.
const COLOR_TOKENS = new Set(
  [
    'azul',
    'blue',
    'marino',
    'celeste',
    'turquesa',
    'beige',
    'nude',
    'camel',
    'topo',
    'vison',
    'champan',
    'desert',
    'desierto',
    'cristal',
    'crystal',
    'rojo',
    'red',
    'granate',
    'burdeos',
    'coral',
    'rosa',
    'pink',
    'fucsia',
    'negro',
    'black',
    'blanco',
    'white',
    'gris',
    'grey',
    'gray',
    'marengo',
    'verde',
    'green',
    'kaki',
    'caqui',
    'marron',
    'brown',
    'chocolate',
    'morado',
    'purple',
    'lila',
    'malva',
    'violeta',
    'amarillo',
    'yellow',
    'mostaza',
    'naranja',
    'orange',
    'dorado',
    'gold',
    'plata',
    'silver',
    'leopardo',
    'animal',
  ].map(normalize),
);

const COLOR_OPTION_NAMES = new Set([
  'color',
  'colors',
  'colour',
  'colours',
  'colores',
  'couleur',
  'couleurs',
  'colore',
  'colori',
]);

/**
 * The canonical garment type for a product, or null when nothing recognisable
 * is found. The title is authoritative; productType and tags are consulted only
 * as a fallback because they are unreliable in this catalogue.
 */
export function classifyGarmentType(
  title: string,
  productType = '',
  tags: string[] = [],
): GarmentType | null {
  const normalizedTitle = normalize(title);

  for (const [type, keywords] of GARMENT_TYPE_KEYWORDS) {
    if (keywords.some((keyword) => containsKeyword(normalizedTitle, keyword))) {
      return type;
    }
  }

  const normalizedFallback = [productType, ...tags].map(normalize).join(' ');

  for (const [type, keywords] of GARMENT_TYPE_KEYWORDS) {
    if (
      keywords.some((keyword) => containsKeyword(normalizedFallback, keyword))
    ) {
      return type;
    }
  }

  return null;
}

/**
 * Maps a free-text garment word the customer used onto a canonical type, or
 * null when it is not a garment type we filter on (so the caller can choose to
 * not filter rather than filter to nothing).
 */
export function canonicalGarmentType(requested: string): GarmentType | null {
  const normalized = normalize(requested);

  if (!normalized) {
    return null;
  }

  // Longest matching synonym wins so that "braga" resolves to panty rather than
  // bra: both "braga" and the substring "bra" match, but "braga" is longer. A
  // plain first-match would let the shorter, wrong synonym win.
  let best: { type: GarmentType; length: number } | null = null;

  for (const [type, synonyms] of REQUESTED_TYPE_SYNONYMS) {
    for (const synonym of synonyms) {
      if (
        containsKeyword(normalized, synonym) &&
        synonym.length > (best?.length ?? 0)
      ) {
        best = { type, length: synonym.length };
      }
    }
  }

  return best?.type ?? null;
}

/**
 * Every colour a product is offered in, read from BOTH the COLOR variant option
 * and any colour word in the title. Values are returned as they appear in the
 * catalogue (e.g. "BLUE", "NEGRO") and de-duplicated case-insensitively, first
 * occurrence wins.
 */
export function extractColors(
  title: string,
  options: ProductOption[] = [],
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const key = normalize(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      found.push(value.trim());
    }
  };

  for (const option of options) {
    if (COLOR_OPTION_NAMES.has(normalize(option.name))) {
      for (const value of option.values) {
        add(value);
      }
    }
  }

  for (const token of title.split(/[\s/,()-]+/)) {
    if (COLOR_TOKENS.has(normalize(token))) {
      add(token);
    }
  }

  return found;
}
