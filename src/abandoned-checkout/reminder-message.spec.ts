import { renderReminderMessage } from './reminder-message';

describe('renderReminderMessage', () => {
  const values = {
    name: 'Ana',
    link: 'https://shop.example/recover/abc',
  };

  it('fills the name and link placeholders', () => {
    expect(
      renderReminderMessage('Hola {{name}}, tu carrito: {{link}}', values),
    ).toBe('Hola Ana, tu carrito: https://shop.example/recover/abc');
  });

  it('is tolerant of spacing and casing in placeholders', () => {
    expect(renderReminderMessage('{{ Name }} -> {{ LINK }}', values)).toBe(
      'Ana -> https://shop.example/recover/abc',
    );
  });

  it('appends the link when the message omits it', () => {
    expect(renderReminderMessage('Hola {{name}}, vuelve!', values)).toBe(
      'Hola Ana, vuelve!\nhttps://shop.example/recover/abc',
    );
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(renderReminderMessage('{{name}} {{name}}', values)).toBe(
      'Ana Ana\nhttps://shop.example/recover/abc',
    );
  });
});
