/**
 * Stop a message going out with an unfilled placeholder such as
 * [CONFIRM PRICE] or [DATE NEEDED]. PigeonBox drafts use them where a fact is
 * missing; sending one by accident would look careless or be wrong. The
 * person can still send anyway.
 */
import { findPlaceholders } from '@pigeonbox/shared';

export type GuardedComposeView = {
  on?: (event: string, cb: (event?: { cancel?: () => void }) => void) => void;
  getTextContent?: () => string;
  getBodyElement?: () => HTMLElement | null;
};

/** The distinct placeholders in `text`, in order. */
export function unresolvedPlaceholders(text: string): string[] {
  return [...new Set(findPlaceholders(text).map((placeholder) => placeholder.token))];
}

export function placeholderWarning(tokens: string[]): string {
  const list = tokens.slice(0, 5).join(', ');
  return `This message still contains ${tokens.length === 1 ? 'a placeholder' : 'placeholders'} for you to fill in: ${list}.\n\nSend it anyway?`;
}

export function attachPlaceholderGuard(view: GuardedComposeView, confirmSend: (message: string) => boolean = (message) => window.confirm(message)): void {
  view.on?.('presending', (event) => {
    let text = '';
    try {
      text = view.getTextContent?.() ?? view.getBodyElement?.()?.innerText ?? '';
    } catch {
      return;
    }
    const tokens = unresolvedPlaceholders(text);
    if (!tokens.length) return;
    if (!confirmSend(placeholderWarning(tokens))) event?.cancel?.();
  });
}
