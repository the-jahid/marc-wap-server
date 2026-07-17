type RangeValue<T> = {
  min: number;
  max: number;
  value: T;
};

const EU_BAND_RANGES: RangeValue<number>[] = [
  { min: 57, max: 62, value: 60 },
  { min: 63, max: 67, value: 65 },
  { min: 68, max: 72, value: 70 },
  { min: 73, max: 77, value: 75 },
  { min: 78, max: 82, value: 80 },
  { min: 83, max: 87, value: 85 },
  { min: 88, max: 92, value: 90 },
  { min: 93, max: 97, value: 95 },
  { min: 98, max: 102, value: 100 },
  { min: 103, max: 107, value: 105 },
  { min: 108, max: 112, value: 110 },
  { min: 113, max: 117, value: 115 },
  { min: 118, max: 122, value: 120 },
  { min: 123, max: 126, value: 125 },
  { min: 127, max: 132, value: 130 },
];

const CUP_RANGES: RangeValue<string>[] = [
  { min: 10, max: 11, value: 'AA' },
  { min: 12, max: 13, value: 'A' },
  { min: 14, max: 15, value: 'B' },
  { min: 16, max: 17, value: 'C' },
  { min: 18, max: 19, value: 'D' },
  { min: 20, max: 21, value: 'E' },
  { min: 22, max: 23, value: 'F' },
  { min: 24, max: 25, value: 'G' },
  { min: 26, max: 27, value: 'H' },
  { min: 28, max: 29, value: 'I' },
  { min: 30, max: 32, value: 'J' },
];

const NUMBER_PATTERN = /(?<!\d)\d{1,3}(?:[.,]\d{1,2})?(?!\d)/g;
const MEASUREMENT_KEYWORD =
  /\b(cm|cms|centimeters?|centimetres?|measurements?|under\s*bust|over\s*bust|band|bust|bra|size|medidas?|cent[i\u00ed]metros?|contorno|bajo pecho|busto|pecho|talla)\b/i;

export const BRA_SIZE_SAFETY_REPLY =
  'Con estas medidas no puedo calcular una talla aproximada de forma segura. Para evitar darle una talla incorrecta, prefiero que un asesor experto lo revise.';

export type BraSizeReply = {
  reply: string;
  needsHumanAttention: boolean;
  attentionReason: string | null;
};

/**
 * Returns null when the message does not look like a two-measurement bra-size
 * request. Once a request is recognized, invalid or unsupported measurements
 * always produce the safety response instead of an invented size.
 */
export function createBraSizeReply(userText: string): BraSizeReply | null {
  const measurements = extractMeasurements(userText);

  if (!measurements) {
    return null;
  }

  const [first, second] = measurements;
  const underbust = Math.min(first, second);
  const bust = Math.max(first, second);
  const euBand = findRangeValue(EU_BAND_RANGES, underbust);
  const cup = euBand ? findRangeValue(CUP_RANGES, bust - euBand) : undefined;

  if (!euBand || !cup || underbust === bust) {
    return {
      reply: BRA_SIZE_SAFETY_REPLY,
      needsHumanAttention: true,
      attentionReason:
        'The supplied bra measurements are outside the supported FR/ES sizing table or do not make sense.',
    };
  }

  const frEsBand = euBand + 15;
  const size = `${frEsBand} ${cup} (FR/ES)`;

  return {
    reply: `Gracias. Según las medidas que nos ha facilitado, su talla recomendada sería: ${size}.\n\nEsta talla es una recomendación aproximada y puede variar según el modelo.`,
    needsHumanAttention: false,
    attentionReason: null,
  };
}

function extractMeasurements(userText: string): [number, number] | null {
  const matches = [...userText.matchAll(NUMBER_PATTERN)];

  if (matches.length !== 2 || !looksLikeMeasurementRequest(userText)) {
    return null;
  }

  const values = matches.map((match) =>
    Number.parseFloat(match[0].replace(',', '.')),
  );

  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return [values[0], values[1]];
}

function looksLikeMeasurementRequest(userText: string): boolean {
  if (MEASUREMENT_KEYWORD.test(userText)) {
    return true;
  }

  const nonMeasurementText = userText
    .replace(NUMBER_PATTERN, ' ')
    .replace(/\b(cm|cms|and|y|et)\b/gi, ' ')
    .replace(/[\s.,;:/\\|+\-&()x\u00d7]+/g, '');

  return nonMeasurementText.length === 0;
}

function findRangeValue<T>(
  ranges: RangeValue<T>[],
  measurement: number,
): T | undefined {
  return ranges.find(({ min, max }) => measurement >= min && measurement <= max)
    ?.value;
}
