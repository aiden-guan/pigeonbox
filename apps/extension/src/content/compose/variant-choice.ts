/**
 * The reply version picked in the PigeonBox panel, remembered per prepared
 * draft so opening Gmail's own Reply puts that version in. Ids only, never
 * text, and only the most recent few.
 */
export const VARIANT_CHOICE_KEY = 'preparedVariantChoice';
const MAX_CHOICES = 20;

export function rememberVariantChoice(choices: Record<string, string> | undefined, draftId: string, variantId: string): Record<string, string> {
  const next = Object.entries({ ...(choices ?? {}) }).filter(([id]) => id !== draftId);
  next.push([draftId, variantId]);
  return Object.fromEntries(next.slice(-MAX_CHOICES));
}
