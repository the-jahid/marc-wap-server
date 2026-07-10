import {
  BRA_SIZE_SAFETY_REPLY,
  createBraSizeReply,
} from './bra-size-calculator';

describe('createBraSizeReply', () => {
  it.each([
    ['109 and 139', '125 I (FR/ES)'],
    ['83 and 113', '100 I (FR/ES)'],
    ['83,113', '100 I (FR/ES)'],
    ['83,5 cm y 113 cm', '100 I (FR/ES)'],
    ['My measurements are 57 cm and 70 cm', '75 AA (FR/ES)'],
    ['pecho 160, bajo pecho 132', '145 J (FR/ES)'],
  ])('calculates %s as %s without exposing the EU size', (text, size) => {
    const result = createBraSizeReply(text);

    expect(result?.reply).toContain(size);
    expect(result?.needsHumanAttention).toBe(false);
    expect(result?.attentionReason).toBeNull();
    expect(result?.reply).not.toContain(' EU');
  });

  it.each(['56 and 86', '133 cm and 163 cm', '83 and 92', '83 and 118'])(
    'uses the safety response for unsupported measurements: %s',
    (text) => {
      const result = createBraSizeReply(text);

      expect(result?.reply).toBe(BRA_SIZE_SAFETY_REPLY);
      expect(result?.needsHumanAttention).toBe(true);
      expect(typeof result?.attentionReason).toBe('string');
    },
  );

  it.each([
    'What are your opening hours from 9 to 5?',
    'I would like 2 bras for less than 100 euros',
    'My underbust is 83 cm',
  ])('does not intercept unrelated or incomplete messages: %s', (text) => {
    expect(createBraSizeReply(text)).toBeNull();
  });
});
