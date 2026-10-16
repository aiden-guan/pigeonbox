// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SENT_WITH_URL } from '@pigeonbox/tracking';
import { composerIsEmpty } from './prepared-reply';
import { hasFooter, insertSentWithFooter } from './compose-extras';

function body(html: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

describe('Sent with PigeonBox footer', () => {
  it('goes after the signature and above quoted history, linking to the site', () => {
    const el = body('<div><br></div><div class="gmail_signature">Aiden</div><div class="gmail_quote">On Mon, Ada wrote:</div>');
    expect(insertSentWithFooter(el)).toBe(true);
    const children = [...el.children];
    const footer = el.querySelector('[data-pigeonbox-footer="1"]')!;
    expect(children.indexOf(footer)).toBeGreaterThan(children.indexOf(el.querySelector('.gmail_signature')!));
    expect(children.indexOf(footer)).toBeLessThan(children.indexOf(el.querySelector('.gmail_quote')!));
    expect(footer.textContent).toBe('Sent with PigeonBox');
    expect(footer.querySelector('a')!.getAttribute('href')).toBe(SENT_WITH_URL);
    expect(hasFooter(el)).toBe(true);
  });

  it('is added once, including to a reopened draft that kept it', () => {
    const el = body('<div><br></div>');
    expect(insertSentWithFooter(el)).toBe(true);
    expect(insertSentWithFooter(el)).toBe(false);
    const reopened = body(`<div>Hi</div><div>Sent with <a href="${SENT_WITH_URL}">PigeonBox</a></div>`);
    expect(insertSentWithFooter(reopened)).toBe(false);
  });

  it('does not count as the person’s words, so AI drafts still fill the compose', () => {
    const el = body('<div><br></div>');
    insertSentWithFooter(el);
    expect(composerIsEmpty(el)).toBe(true);
  });

  it('is gone once the person deletes it', () => {
    const el = body('<div><br></div>');
    insertSentWithFooter(el);
    el.querySelector('[data-pigeonbox-footer="1"]')!.remove();
    expect(hasFooter(el)).toBe(false);
  });
});
