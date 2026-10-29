// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachComposeExtras, type ComposeExtrasDeps } from './compose-extras';

const deps: ComposeExtrasDeps = {
  myName: () => 'Aiden',
  snippets: async () => [],
  remind: async () => ({ ok: true }),
  reminderBusinessDays: () => 3,
  toast: () => undefined,
};

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('compose extras', () => {
  it('never adds anything to the message, when the compose opens or at send', async () => {
    vi.useFakeTimers();
    const element = document.createElement('div');
    const body = document.createElement('div');
    body.setAttribute('contenteditable', 'true');
    body.innerHTML = '<div><br></div><div class="gmail_signature">Aiden</div><div class="gmail_quote">On Mon, Ada wrote:</div>';
    element.append(body);
    document.body.append(element);
    const handlers = new Map<string, (event?: unknown) => void>();
    const view = { getElement: () => element, getBodyElement: () => body, on: (name: string, handler: (event?: unknown) => void) => void handlers.set(name, handler) };
    const before = body.innerHTML;

    attachComposeExtras(view as never, deps);
    await vi.advanceTimersByTimeAsync(1_000);
    handlers.get('presending')?.();

    expect(body.innerHTML).toBe(before);
    expect(body.textContent).not.toContain('Sent with');
    expect(body.querySelector('a')).toBeNull();
  });
});
