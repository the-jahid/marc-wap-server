const NAME_PLACEHOLDER = /\{\{\s*name\s*\}\}/gi;
const LINK_PLACEHOLDER = /\{\{\s*link\s*\}\}/gi;

/**
 * Fills an operator-written reminder message with the customer's name and cart
 * recovery link. `{{name}}` and `{{link}}` are replaced (any spacing/casing,
 * e.g. `{{ Name }}`). If the message never mentions the link, it is appended so
 * the cart URL is always delivered — a reminder without the link is pointless.
 */
export function renderReminderMessage(
  template: string,
  values: { name: string; link: string },
): string {
  const hasLinkPlaceholder = LINK_PLACEHOLDER.test(template);
  // `.test` on a global regex advances lastIndex; reset before replacing.
  LINK_PLACEHOLDER.lastIndex = 0;

  let message = template
    .replace(NAME_PLACEHOLDER, values.name)
    .replace(LINK_PLACEHOLDER, values.link)
    .trim();

  if (!hasLinkPlaceholder) {
    message = message ? `${message}\n${values.link}` : values.link;
  }

  return message;
}
