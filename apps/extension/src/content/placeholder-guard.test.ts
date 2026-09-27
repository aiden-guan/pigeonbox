import { describe, expect, it, vi } from 'vitest';
import { attachPlaceholderGuard, placeholderWarning, unresolvedPlaceholders } from './placeholder-guard';

function composeView(text: string) {
  const handlers: Record<string, (event?: { cancel?: () => void }) => void> = {};
  return {
    view: { on: (name: string, cb: (event?: { cancel?: () => void }) => void) => void (handlers[name] = cb), getTextContent: () => text },
    presend: () => {
      const cancel = vi.fn();
      handlers.presending?.({ cancel });
      return cancel;
    },
  };
}

describe('placeholder guard', () => {
  it('finds each distinct placeholder once', () => {
    expect(unresolvedPlaceholders('Total [CONFIRM PRICE], by [DATE NEEDED], again [CONFIRM PRICE].')).toEqual(['[CONFIRM PRICE]', '[DATE NEEDED]']);
    expect(unresolvedPlaceholders('All filled in. [sic] and [1] are fine.')).toEqual([]);
    expect(placeholderWarning(['[DATE NEEDED]'])).toContain('a placeholder for you to fill in: [DATE NEEDED]');
  });

  it('holds the send until the person decides', () => {
    const declined = composeView('The price is [CONFIRM PRICE].');
    const ask = vi.fn(() => false);
    attachPlaceholderGuard(declined.view, ask);
    expect(declined.presend()).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledOnce();

    const accepted = composeView('The price is [CONFIRM PRICE].');
    attachPlaceholderGuard(accepted.view, () => true);
    expect(accepted.presend()).not.toHaveBeenCalled();
  });

  it('stays out of the way for ordinary messages', () => {
    const plain = composeView('Thanks, see you Friday.');
    const ask = vi.fn(() => false);
    attachPlaceholderGuard(plain.view, ask);
    expect(plain.presend()).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
});
