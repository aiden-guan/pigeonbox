/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { DomFallbackAdapter } from './DomFallbackAdapter.js';
import type { MailboxEvent } from './types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('event semantics', () => {
  it('observes thread-to-list hash navigation and reopening the same thread', async () => {
    location.hash = '#inbox/abc123';
    const content = '<h2 class="hP" data-legacy-thread-id="abc123">Pricing</h2><div class="a3s" data-legacy-message-id="m1">Reply by Friday</div>';
    document.body.innerHTML = `<div role="main">${content}</div>`;
    const events: MailboxEvent[] = [];
    const adapter = new DomFallbackAdapter({ debounceMs: 0 });
    await adapter.start((event) => events.push(event));
    await wait(20);
    events.length = 0;
    document.querySelector('[role="main"]')!.innerHTML = '';
    location.hash = '#inbox';
    await wait(20);
    expect(events).toContainEqual(expect.objectContaining({ type: 'ROUTE_CHANGED', route: 'inbox', query: '#inbox' }));
    document.querySelector('[role="main"]')!.innerHTML = content;
    location.hash = '#inbox/abc123';
    await wait(20);
    expect(events.filter((event) => event.type === 'THREAD_OPENED')).toHaveLength(1);
    await adapter.stop();
    events.length = 0; location.hash = '#sent';
    await wait(20); expect(events).toHaveLength(0);
  });
  it('treats reorder, read, and archive as list changes, not new mail', async () => {
    document.body.innerHTML = `
      <div role="main">
        <table>
          <tr class="zA zE" data-legacy-thread-id="thread-1"><td class="y6"><span class="bog">One</span></td><td class="y2">A</td></tr>
          <tr class="zA" data-legacy-thread-id="thread-2"><td class="y6"><span class="bog">Two</span></td><td class="y2">B</td></tr>
        </table>
      </div>`;
    const events: MailboxEvent[] = [];
    const adapter = new DomFallbackAdapter({ debounceMs: 0 });
    await adapter.start((event) => events.push(event));
    await wait(20);
    events.length = 0;

    const table = document.querySelector('table')!;
    const rows = [...table.querySelectorAll('tr')];
    table.append(rows[0]!);
    document.body.append(document.createElement('span'));
    await wait(20);
    expect(events.some((event) => event.type === 'VISIBLE_ROWS_CHANGED')).toBe(true);
    expect(events.some((event) => event.type === 'MESSAGE_ARRIVED')).toBe(false);

    events.length = 0;
    document.querySelector('.zE')?.classList.remove('zE');
    document.body.append(document.createElement('i'));
    await wait(20);
    expect(events.map((event) => event.type)).not.toContain('MESSAGE_ARRIVED');

    events.length = 0;
    document.querySelector('[data-legacy-thread-id="thread-2"]')?.remove();
    document.body.append(document.createElement('b'));
    await wait(20);
    expect(events.some((event) => event.type === 'VISIBLE_ROWS_CHANGED')).toBe(true);
    expect(events.some((event) => event.type === 'MESSAGE_ARRIVED')).toBe(false);
    await adapter.stop();
  });

  it('emits THREAD_OPENED when a thread is open', async () => {
    document.body.innerHTML = `
      <div role="main">
        <h2 class="hP" data-legacy-thread-id="thread-9">Hello</h2>
        <div class="a3s" data-legacy-message-id="m1">Can you meet Thursday?</div>
      </div>`;
    const events: MailboxEvent[] = [];
    const adapter = new DomFallbackAdapter({ debounceMs: 0 });
    await adapter.start((event) => events.push(event));
    await wait(20);
    const opened = events.find((event) => event.type === 'THREAD_OPENED');
    expect(opened && opened.type === 'THREAD_OPENED' ? opened.thread.threadId : '').toBe('thread-9');
    expect(events.some((event) => event.type === 'MESSAGE_ARRIVED')).toBe(false);
    await adapter.stop();
  });
});
