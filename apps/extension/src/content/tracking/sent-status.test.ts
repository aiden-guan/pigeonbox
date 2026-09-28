/**
 * @vitest-environment jsdom
 */
import type { TrackedEmailSummary } from '@pigeonbox/tracking';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSentStatus, paintConversation, paintRows } from './sent-status';

const opened: TrackedEmailSummary = {
  trackingId: 'trk_open',
  subject: 'Hello',
  sender: 'me@example.com',
  recipients: ['aiden@example.com'],
  gmailThreadId: 'thread-1',
  gmailMessageId: 'msg-1',
  sentAt: '2026-09-22T15:00:00.000Z',
  firstOpenedAt: '2026-09-22T15:00:20.000Z',
  lastOpenedAt: '2026-09-22T15:00:20.000Z',
  openCount: 2,
  clickCount: 0,
  notifyIfNoReply: false,
};

const waiting: TrackedEmailSummary = {
  ...opened,
  trackingId: 'trk_wait',
  gmailThreadId: 'thread-2',
  recipients: ['sam@example.com'],
  subject: 'Follow up',
  firstOpenedAt: null,
  lastOpenedAt: null,
  openCount: 0,
};

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.style.backgroundColor = '';
  document.getElementById('gi-track-style')?.remove();
  document.querySelector('[data-gi-ui="track-card"]')?.remove();
});

function row(threadId: string, email: string, subject: string): void {
  document.body.innerHTML += `
    <table><tbody>
      <tr class="zA" data-legacy-thread-id="${threadId}">
        <td class="yX"><div class="yW"><span email="${email}">${email}</span></div></td>
        <td><span class="bog">${subject}</span></td>
      </tr>
    </tbody></table>
  `;
}

describe('sent mail open status', () => {
  it('shows a copper opened check and a gray not-opened check', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    row('thread-2', 'sam@example.com', 'Follow up');
    paintRows(document, [opened, waiting], 'https://track.example', () => undefined);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.gi-track-btn')];
    expect(buttons.map((button) => button.dataset.state)).toEqual(['opened', 'pending']);
    expect(buttons[0].getAttribute('aria-label')).toMatch(/opened your email/);
    expect(buttons[0].textContent).not.toMatch(/Opened/);
    expect(buttons[1].getAttribute('aria-label')).toBe('Not opened yet.');
    expect(buttons[0].style.color).toBe('rgb(147, 80, 35)');
    expect(buttons[1].style.color).toBe('rgb(128, 134, 139)');
    expect(document.querySelector('[data-legacy-thread-id="thread-1"]')?.getAttribute('data-gi-tracked')).toBe('opened');
    const slot = document.querySelector('[data-legacy-thread-id="thread-1"] .gi-track-slot');
    expect(slot?.parentElement?.classList.contains('yW')).toBe(true);
    expect(slot?.parentElement?.firstElementChild).toBe(slot);
  });

  it('opens a status card with the open count and a no-reply switch', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    const onNotify = vi.fn();
    paintRows(document, [opened], 'https://track.example', onNotify);
    const button = document.querySelector<HTMLButtonElement>('.gi-track-btn');
    button?.click();
    const card = document.querySelector('[data-gi-ui="track-card"]');
    expect(card?.textContent).toContain('aiden@example.com');
    expect(card?.textContent).toContain('opened your email');
    expect(card?.textContent).toContain('First opened');
    expect(card?.textContent).toContain('Opened 2 times');
    expect(card?.textContent).toContain('Notify me if there is no reply');
    card?.querySelector<HTMLButtonElement>('[role="switch"]')?.click();
    expect(onNotify).toHaveBeenCalledWith('trk_open', true);
    card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('[data-gi-ui="track-card"]')).toBeNull();
  });

  it('paints a modern row whose id is on the subject span, and the open conversation', () => {
    document.body.innerHTML = `
      <div>
        <h2 class="hP">Hello</h2>
        <span email="aiden@example.com">Aiden</span>
      </div>
      <table><tbody>
        <tr>
          <td><span email="aiden@example.com">To: Aiden</span></td>
          <td><span data-thread-id="msg-f:1" data-legacy-thread-id="thread-1">Hello</span></td>
        </tr>
      </tbody></table>
    `;
    paintRows(document, [opened], 'https://track.example', () => undefined);
    paintConversation(document, [opened], 'https://track.example', () => undefined);
    const buttons = [...document.querySelectorAll('.gi-track-btn')];
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    const labeled = buttons.find((button) => button.textContent?.includes('Opened'));
    expect(labeled?.getAttribute('aria-label')).toMatch(/opened your email/);
  });

  it('paints a checkbox row that has no legacy thread class', () => {
    document.body.innerHTML = `
      <div role="main">
        <div role="row">
          <div role="gridcell"><div role="checkbox" aria-checked="false"></div></div>
          <div role="gridcell"><span email="aiden@example.com">To: Aiden</span></div>
          <div role="gridcell"><span>Hello</span></div>
        </div>
      </div>
    `;
    paintRows(document, [opened], 'https://track.example', () => undefined);
    const button = document.querySelector('.gi-track-btn');
    expect(button?.getAttribute('data-state')).toBe('opened');
    expect(button?.getAttribute('aria-label')).toMatch(/opened your email/);
    const name = document.querySelector('[email="aiden@example.com"]');
    expect(name?.parentElement?.firstElementChild?.classList.contains('gi-track-slot')).toBe(true);
  });

  it('uses a bright check when the sent list is dark', () => {
    document.body.style.backgroundColor = 'rgb(32, 33, 36)';
    row('thread-1', 'aiden@example.com', 'Hello');
    paintRows(document, [opened], 'https://track.example', () => undefined);
    expect(document.querySelector<HTMLElement>('.gi-track-btn')?.style.color).toBe('rgb(237, 187, 147)');
  });

  it('leaves untracked rows alone', () => {
    row('thread-9', 'other@example.com', 'Something else');
    paintRows(document, [opened], 'https://track.example', () => undefined);
    expect(document.querySelector('.gi-track-btn')).toBeNull();
  });

  it('warns when the tracker cannot be reached by Gmail', () => {
    row('thread-2', 'sam@example.com', 'Follow up');
    paintRows(document, [waiting], 'http://127.0.0.1:8787', () => undefined);
    document.querySelector<HTMLButtonElement>('.gi-track-btn')?.click();
    expect(document.querySelector('[data-gi-ui="track-card"]')?.textContent).toMatch(/cannot reach this computer/);
  });

  it('updates row dataset and avoids stale closure when row is recycled', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    const onSelfView = vi.fn();
    // First paint with opened email
    paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);
    const rowEl = document.querySelector<HTMLTableRowElement>('.zA')!;
    expect(rowEl.dataset.giTrackingId).toBe('trk_open');

    // Simulate Gmail recycling the row for a different thread
    rowEl.setAttribute('data-legacy-thread-id', 'thread-2');
    rowEl.querySelector('[email]')?.setAttribute('email', 'sam@example.com');
    rowEl.querySelector('.bog')!.textContent = 'Follow up';

    // Repaint with waiting email
    paintRows(document, [waiting], 'https://track.example', () => undefined, onSelfView);
    expect(rowEl.dataset.giTrackingId).toBe('trk_wait');

    // Click the recycled row - must report trk_wait, NOT trk_open!
    rowEl.click();
    expect(onSelfView).toHaveBeenCalledTimes(1);
    expect(onSelfView).toHaveBeenCalledWith('trk_wait', 'thread-2', 'msg-1', expect.any(Number), 'ROW_INTERACTION');
  });

  it('captures early pointerdown interaction and deduplicates rapid subsequent click', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    const onSelfView = vi.fn();
    paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);
    const rowEl = document.querySelector<HTMLTableRowElement>('.zA')!;

    // 1. Pointerdown fires first at T=0
    rowEl.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onSelfView).toHaveBeenCalledTimes(1);
    expect(onSelfView).toHaveBeenCalledWith('trk_open', 'thread-1', 'msg-1', expect.any(Number), 'ROW_INTERACTION');

    // 2. Click fires immediately after (e.g. 50ms later) -> deduplicated by 10s window in installSentStatus
    rowEl.click();
  });

  it('installSentStatus deduplicates rapid repeated self-view interactions within 10s', () => {
    row('thread-1', 'aiden@example.com', 'Hello');
    const onSelfView = vi.fn();
    const controller = installSentStatus({
      emails: [opened],
      trackerBaseUrl: 'https://track.example',
      onNotify: () => undefined,
      onSelfView,
    });
    const rowEl = document.querySelector<HTMLTableRowElement>('.zA')!;

    // Pointerdown early hint
    rowEl.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onSelfView).toHaveBeenCalledTimes(1);
    expect(onSelfView).toHaveBeenCalledWith('trk_open', 'thread-1', 'msg-1', expect.any(Number), 'ROW_INTERACTION');

    // Follow-up click from browser
    rowEl.click();
    // Deduplicated!
    expect(onSelfView).toHaveBeenCalledTimes(1);

    controller.destroy();
  });

  describe('Priority 3 & Section 10: only thread navigation targets emit row-level view hint', () => {
    it('clicking subject emits ROW_INTERACTION SELF_VIEW hint', () => {
      document.body.innerHTML = `
        <table><tbody>
          <tr class="zA" data-legacy-thread-id="thread-1">
            <td class="yX"><div class="yW"><span email="aiden@example.com">Aiden</span></div></td>
            <td><span class="bog">Subject Text</span></td>
          </tr>
        </tbody></table>
      `;
      const onSelfView = vi.fn();
      paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);

      const subjectEl = document.querySelector('.bog')!;
      subjectEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onSelfView).toHaveBeenCalledTimes(1);
      expect(onSelfView).toHaveBeenCalledWith('trk_open', 'thread-1', 'msg-1', expect.any(Number), 'ROW_INTERACTION');
    });

    it('clicking checkbox does NOT emit SELF_VIEW', () => {
      document.body.innerHTML = `
        <table><tbody>
          <tr class="zA" data-legacy-thread-id="thread-1">
            <td class="oZ-x3"><div role="checkbox" class="T-Jo" aria-checked="false"></div></td>
            <td class="yX"><div class="yW"><span email="aiden@example.com">Aiden</span></div></td>
            <td><span class="bog">Subject Text</span></td>
          </tr>
        </tbody></table>
      `;
      const onSelfView = vi.fn();
      paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);

      const checkboxEl = document.querySelector('[role="checkbox"]')!;
      checkboxEl.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      checkboxEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onSelfView).not.toHaveBeenCalled();
    });

    it('clicking star does NOT emit SELF_VIEW', () => {
      document.body.innerHTML = `
        <table><tbody>
          <tr class="zA" data-legacy-thread-id="thread-1">
            <td class="apU"><span class="T-KT" aria-label="Not starred" role="button"></span></td>
            <td class="yX"><div class="yW"><span email="aiden@example.com">Aiden</span></div></td>
            <td><span class="bog">Subject Text</span></td>
          </tr>
        </tbody></table>
      `;
      const onSelfView = vi.fn();
      paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);

      const starEl = document.querySelector('.T-KT')!;
      starEl.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      starEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onSelfView).not.toHaveBeenCalled();
    });

    it('clicking Gmail row menu / hover action does NOT emit SELF_VIEW', () => {
      document.body.innerHTML = `
        <table><tbody>
          <tr class="zA" data-legacy-thread-id="thread-1">
            <td class="yX"><div class="yW"><span email="aiden@example.com">Aiden</span></div></td>
            <td><span class="bog">Subject Text</span></td>
            <td class="bq9"><button data-tooltip="Archive" aria-label="Archive"></button></td>
          </tr>
        </tbody></table>
      `;
      const onSelfView = vi.fn();
      paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);

      const actionBtn = document.querySelector('.bq9 button')!;
      actionBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      actionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onSelfView).not.toHaveBeenCalled();
    });

    it('clicking tracking status control does NOT emit SELF_VIEW', () => {
      row('thread-1', 'aiden@example.com', 'Hello');
      const onSelfView = vi.fn();
      paintRows(document, [opened], 'https://track.example', () => undefined, onSelfView);

      const trackBtn = document.querySelector('.gi-track-btn')!;
      trackBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onSelfView).not.toHaveBeenCalled();
    });
  });

  it('paintConversation does not emit self-view', () => {
    document.body.innerHTML = `
      <div>
        <h2 class="hP">Hello</h2>
        <span email="aiden@example.com">Aiden</span>
      </div>
    `;
    const onNotify = vi.fn();
    const onLink = vi.fn();
    paintConversation(document, [opened], 'https://track.example', onNotify, onLink);
    // paintConversation should render the slot without triggering any self view
    expect(document.querySelector('.gi-track-slot')).not.toBeNull();
  });
});
