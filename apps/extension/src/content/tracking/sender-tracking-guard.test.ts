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

describe('sender drafting a reply inside their own tracked thread', () => {
  const PROXY = 'https://ci3.googleusercontent.com/meips/ADKq_Nb=s0-d-e1-ft';
  const OWN = `${PROXY}#${BASE}/open/trk_own`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const composer = (quote: string) => `<div contenteditable="true" role="textbox" aria-label="Message Body"><div>new reply text</div><img id="typed" src="https://example.com/user-photo.png">${quote}</div>`;
  const quoted = (attrs = `src="${OWN}"`) => `<div class="gmail_quote"><div class="gmail_attr">On Mon, Owner wrote:</div><blockquote class="gmail_quote">previous sent message<img id="quoted-pixel" ${attrs} width="1" height="1"><a id="quoted-link" href="${BASE}/c/clk_q">article</a></blockquote></div>`;
  function install(bases: string | string[] | null = BASE, owned = ['trk_own']) {
    const onPixelRender = vi.fn();
    const resolveLink = vi.fn(async () => 'https://example.com/article');
    guard = installSenderTrackingGuard({ getTrackerBases: () => bases, getOwnedTrackingIds: () => new Set(owned), resolveLink, onPixelRender }, document);
    return { onPixelRender, resolveLink };
  }
  const editor = () => document.querySelector<HTMLElement>('[contenteditable="true"]')!;

  it('never mutates the draft, reports each actual quoted render once, and survives a minute of typing and autosaves', async () => {
    document.body.innerHTML = `<div role="main"><div data-legacy-message-id="abcd"><div class="a3s">Scope attached.<img id="sent-pixel" src="${OWN}"></div></div><div id="reply-slot"></div></div>`;
    const { onPixelRender, resolveLink } = install();
    // 1-2. The sender opens their own sent message; its pixel is neutralized and reported.
    expect(document.querySelector('#sent-pixel')!.getAttribute('src')).toMatch(/^data:image/);
    expect(onPixelRender.mock.calls).toEqual([['trk_own', false]]);

    // 3. Reply: Gmail inserts an inline composer whose quote still carries the tracked pixel.
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    document.querySelector('#reply-slot')!.innerHTML = composer(quoted());
    await settle();
    // The same edits applied outside the document, where the guard cannot reach.
    const mirror = editor().cloneNode(true) as HTMLElement;
    expect(document.querySelector('#quoted-pixel')!.getAttribute('src')).toBe(OWN);
    expect(onPixelRender.mock.calls).toEqual([['trk_own', false], ['trk_own', true]]);

    // 4-6. A minute of typing and autosaves. Typing never re-reports the same image node.
    for (let second = 1; second <= 61; second++) {
      clock.mockReturnValue(start + second * 1000);
      for (const root of [editor(), mirror]) {
        const line = document.createElement('div');
        line.textContent = `line ${second}`;
        root.insertBefore(line, root.querySelector('.gmail_quote'));
        (line.firstChild as Text).appendData('!');
        root.querySelector('div')!.setAttribute('data-autosave', String(second));
        if (second % 12 === 0) {
          // Gmail rebuilds the quote while saving: a brand new image node is a new render.
          root.querySelector('.gmail_quote')!.replaceWith(root.querySelector('.gmail_quote')!.cloneNode(true));
        }
      }
      if (second % 20 === 0) {
        // 7. Gmail restores the lazily loaded pixel on the rendered sent copy.
        document.querySelector('#sent-pixel')!.setAttribute('src', `${OWN}&restored=${second}`);
      }
      await settle();
    }
    const quotedReports = onPixelRender.mock.calls.filter(([, isQuoted]) => isQuoted).length;
    const renderedReports = onPixelRender.mock.calls.filter(([, isQuoted]) => !isQuoted).length;
    expect(quotedReports).toBe(1 + 5); // initial + autosave rebuilds at 12, 24, 36, 48, 60 s
    expect(renderedReports).toBe(1 + 3); // initial + restores at 20, 40, 60 s
    expect(onPixelRender.mock.calls.every(([id]) => id === 'trk_own')).toBe(true);
    expect(document.querySelector('#sent-pixel')!.getAttribute('src')).toMatch(/^data:image/);

    // The draft is exactly what Gmail and the sender wrote: pixel, image, link and quote untouched.
    expect(editor().innerHTML).toBe(mirror.innerHTML);
    expect(document.querySelector('#quoted-pixel')!.getAttribute('src')).toBe(OWN);
    expect(document.querySelector('#typed')!.getAttribute('src')).toBe('https://example.com/user-photo.png');
    expect(document.querySelector('#quoted-link')!.getAttribute('href')).toBe(`${BASE}/c/clk_q`);
    expect(resolveLink).not.toHaveBeenCalledWith(BASE, 'clk_q');
  });

  it.each([
    ['inline reply', (q: string) => `<div role="main"><div id="slot">${composer(q)}</div></div>`],
    ['reply all', (q: string) => `<div role="main"><div role="region" aria-label="Reply all">${composer(q)}</div></div>`],
    ['pop-out compose', (q: string) => `<div role="main"></div><div role="dialog" aria-label="Re: Pricing">${composer(q)}</div>`],
  ])('detects a quoted owned pixel in %s without touching it', async (_name, page) => {
    document.body.innerHTML = page(quoted());
    const { onPixelRender } = install();
    expect(onPixelRender.mock.calls).toEqual([['trk_own', true]]);
    expect(document.querySelector('#quoted-pixel')!.getAttribute('src')).toBe(OWN);
  });

  it('detects forwards, collapsed quotes, data-src, srcset, proxy wrapping and old tracker hostnames', () => {
    const OLD = 'https://old-track.example';
    document.body.innerHTML = `<div role="main"></div>
      <div contenteditable="true" id="fwd"><div class="gmail_quote gmail_quote_container">---------- Forwarded message ---------<br><img id="f" data-src="${BASE}/open/trk_fwd"></div></div>
      <div contenteditable="true" id="collapsed"><div class="gmail_extra" style="display:none"><img id="c" srcset="${PROXY}#${encodeURIComponent(`${OLD}/open/trk_old`)} 1x, ${PROXY}?x=2 2x"></div></div>`;
    const before = document.body.innerHTML;
    const { onPixelRender } = install([BASE, OLD], ['trk_fwd', 'trk_old']);
    expect(onPixelRender.mock.calls).toEqual([['trk_fwd', true], ['trk_old', true]]);
    expect(document.body.innerHTML).toBe(before);
  });

  it('ignores ordinary images, new reply text, other senders, foreign hosts and disabled tracking', async () => {
    document.body.innerHTML = `<div role="main"></div><div contenteditable="true"><div>reply <img src="${BASE}/open/trk_own"></div><blockquote><img src="https://example.com/logo.png"><img src="${BASE}/open/trk_other"><img src="https://evil.example/open/trk_own"></blockquote></div>`;
    const { onPixelRender } = install();
    expect(onPixelRender).not.toHaveBeenCalled();
    guard!.destroy();
    document.body.innerHTML = `<div role="main"></div><div contenteditable="true">${quoted()}</div>`;
    const disabled = install(null);
    await settle();
    expect(disabled.onPixelRender).not.toHaveBeenCalled();
  });

  it('reports a node again only when Gmail restores a new pixel URL on it or the owned list arrives later', async () => {
    document.body.innerHTML = `<div role="main"></div><div contenteditable="true">${quoted()}</div>`;
    let owned: string[] = [];
    const onPixelRender = vi.fn();
    guard = installSenderTrackingGuard({ getTrackerBases: () => BASE, getOwnedTrackingIds: () => new Set(owned), resolveLink: vi.fn(async () => null), onPixelRender });
    expect(onPixelRender).not.toHaveBeenCalled();
    owned = ['trk_own'];
    guard.refresh();
    guard.refresh();
    expect(onPixelRender).toHaveBeenCalledTimes(1);
    const image = document.querySelector('#quoted-pixel')!;
    image.setAttribute('src', OWN);
    await settle();
    expect(onPixelRender).toHaveBeenCalledTimes(1);
    image.setAttribute('src', `${PROXY}?v=2#${BASE}/open/trk_own`);
    await settle();
    expect(onPixelRender).toHaveBeenCalledTimes(2);
  });

  it('neutralizes a rendered sent copy whose pixel only arrives through srcset', () => {
    document.body.innerHTML = `<div role="main"><div class="a3s"><img id="r" src="https://example.com/spacer.gif" srcset="${OWN} 1x"></div></div>`;
    const { onPixelRender } = install();
    const image = document.querySelector('#r')!;
    expect(image.hasAttribute('srcset')).toBe(false);
    expect(image.getAttribute('src')).toBe('https://example.com/spacer.gif');
    expect(extractTrackingIdFromMessageBody(document.querySelector('.a3s')!, BASE)).toBe('trk_own');
    expect(onPixelRender.mock.calls).toEqual([['trk_own', false]]);
  });
});

it('matches configured old tracker origins and Gmail link wrappers only', () => {
  expect(senderClickUrl('https://www.google.com/url?q=' + encodeURIComponent(BASE + '/c/clk_own'), ['https://new.example', BASE])).toEqual({ origin: BASE, clickId: 'clk_own' });
  expect(senderClickUrl('https://evil.example/c/clk_own', BASE)).toBeNull();
  expect(senderClickUrl(BASE + '/c/clk_own', null)).toBeNull();
});
