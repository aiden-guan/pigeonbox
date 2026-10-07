/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractTrackingIdFromMessageBody, extractQuotedTrackingIdsFromMessageBody } from '@pigeonbox/tracking';
import { installSenderTrackingGuard, senderClickUrl } from './sender-tracking-guard';

const BASE = 'https://track.example';
let guard: ReturnType<typeof installSenderTrackingGuard> | undefined;
afterEach(() => { guard?.destroy(); guard = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(html: string, resolveLink = vi.fn(async () => 'https://example.com/article')) {
  document.body.innerHTML = `<div role="main"><section><div class="a3s">${html}</div></section></div>`;
  const onPixelRender = vi.fn();
  guard = installSenderTrackingGuard({ getTrackerBases: () => BASE, getOwnedTrackingIds: () => new Set(['trk_own']), resolveLink, onPixelRender });
  return { resolveLink, onPixelRender };
}

describe('sender copy tracking protection', () => {
  it('disables owned pixels, preserves identity, and leaves other senders and regular images alone', () => {
    const { onPixelRender } = mount(`<img id="own" src="https://ci3.googleusercontent.com/proxy#${BASE}/open/trk_own"><blockquote><img id="quoted" data-src="${BASE}/open/trk_own"></blockquote><img id="other" src="${BASE}/open/trk_other"><img id="photo" src="https://example.com/photo.png">`);
    expect(document.querySelector('#own')!.getAttribute('src')).toMatch(/^data:image/);
    expect(document.querySelector('#quoted')!.hasAttribute('data-src')).toBe(false);
    expect(document.querySelector('#other')!.getAttribute('src')).toBe(`${BASE}/open/trk_other`);
    expect(document.querySelector('#photo')!.getAttribute('src')).toBe('https://example.com/photo.png');
    const body = document.querySelector('.a3s')!;
    expect(extractTrackingIdFromMessageBody(body, BASE)).toBeNull(); // own + another sender are ambiguous
    expect(extractQuotedTrackingIdsFromMessageBody(body, BASE)).toEqual(['trk_own']);
    expect(onPixelRender.mock.calls).toEqual([['trk_own', false], ['trk_own', true]]);
  });

  it('protects an old open tab when Gmail restores a lazy pixel, without fabricating periodic claims', async () => {
    const { onPixelRender } = mount(`<img src="${BASE}/open/trk_own">`);
    const image = document.querySelector('img')!;
    guard!.refresh(); guard!.refresh();
    expect(onPixelRender).toHaveBeenCalledTimes(1);
    // The original claim expired hours ago; protection is tied to the actual render.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    image.setAttribute('src', `${BASE}/open/trk_own`);
    await vi.waitFor(() => expect(onPixelRender).toHaveBeenCalledTimes(2));
    expect(image.getAttribute('src')).toMatch(/^data:image/);
    expect(extractTrackingIdFromMessageBody(document.querySelector('.a3s')!, BASE)).toBe('trk_own');
  });

  it('resolves owned links without visiting the click recorder, even hours later and in quotes', async () => {
    const { resolveLink } = mount(`<blockquote><a href="${BASE}/c/clk_own" data-saferedirecturl="https://www.google.com/url?q=${encodeURIComponent(BASE + '/c/clk_own')}">article</a></blockquote>`);
    const anchor = document.querySelector('a')!;
    await vi.waitFor(() => expect(anchor.href).toBe('https://example.com/article'));
    expect(resolveLink).toHaveBeenCalledWith(BASE, 'clk_own');
    expect(anchor.hasAttribute('data-saferedirecturl')).toBe(false);
    anchor.setAttribute('data-saferedirecturl', `${BASE}/c/clk_own`);
    await vi.waitFor(() => expect(anchor.hasAttribute('data-saferedirecturl')).toBe(false));
    guard!.refresh();
    expect(resolveLink).toHaveBeenCalledTimes(1);
  });

  it('holds an early modified click until the destination is resolved', async () => {
    let finish!: (value: string) => void;
    const resolve = vi.fn(() => new Promise<string>((done) => { finish = done; }));
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({ opener: {}, location: { replace } } as unknown as Window);
    mount(`<a target="_blank" href="${BASE}/c/clk_own">article</a>`, resolve);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    document.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    finish('https://example.com/article');
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('https://example.com/article'));
  });

  it('does not edit draft bodies or rewrite unowned/unsafe destinations', async () => {
    const { resolveLink } = mount(`<div contenteditable="true"><img src="${BASE}/open/trk_own"><a href="${BASE}/c/clk_draft">draft</a></div><a id="foreign" href="https://other.example/c/clk_other">other</a><a id="unsafe" href="${BASE}/c/clk_unsafe">unsafe</a>`, vi.fn(async () => 'javascript:alert(1)'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[contenteditable] img')!.getAttribute('src')).toBe(`${BASE}/open/trk_own`);
    expect(resolveLink).not.toHaveBeenCalledWith(BASE, 'clk_draft');
    expect(document.querySelector('#unsafe')!.getAttribute('href')).toBe(`${BASE}/c/clk_unsafe`);
  });

  it('stops observing when destroyed', async () => {
    const { onPixelRender } = mount(`<img src="${BASE}/open/trk_own">`);
    guard!.destroy();
    document.querySelector('img')!.setAttribute('src', `${BASE}/open/trk_own`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPixelRender).toHaveBeenCalledTimes(1);
  });
});

it('matches configured old tracker origins and Gmail link wrappers only', () => {
  expect(senderClickUrl('https://www.google.com/url?q=' + encodeURIComponent(BASE + '/c/clk_own'), ['https://new.example', BASE])).toEqual({ origin: BASE, clickId: 'clk_own' });
  expect(senderClickUrl('https://evil.example/c/clk_own', BASE)).toBeNull();
  expect(senderClickUrl(BASE + '/c/clk_own', null)).toBeNull();
});
