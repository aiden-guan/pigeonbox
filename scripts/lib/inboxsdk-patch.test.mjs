import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { patchInboxSdkPageWorld, stripQuotedPigeonboxPixels } from './inboxsdk-patch.mjs';

const original = readFileSync(new URL('../../node_modules/@inboxsdk/core/pageWorld.js', import.meta.url), 'utf8');
const patched = patchInboxSdkPageWorld(original);
const section = patched.slice(patched.indexOf('const SEND_ACTIONS ='), patched.indexOf(';// ./src/injected-js/gmail/sync-compose-processor.ts'));
const sdk = runInNewContext(`${section}\n({replaceBodyContentInSendRequestBody, replaceEmailBodyForSendRequest})`, {
  sortBy_default: () => (items, key) => [...items].sort((a, b) => key(a) - key(b)),
  intersection_default: () => (a, b) => a.filter(x => b.includes(x)),
  isNotNil: x => x != null,
}, { timeout: 1000 });
const pixel = '<img src="https://tracker.example/open/trk_old" width="1" height="1">';
const photo = '<img src="https://images.example/photo.jpg">';
const quote = `<br><div class="gmail_quote"><blockquote>Earlier message ${pixel}${photo}<a href="https://example.com">Link</a></blockquote></div>`;
const fresh = '<p>New reply</p><img src="https://tracker.example/open/trk_current">';

test('sanitizes nested, proxied and encoded quoted pixels without changing message content or ordinary images', () => {
  const encoded = `<img data-src="https://proxy.example/?url=${encodeURIComponent(encodeURIComponent('https://tracker.example/open/trk_encoded'))}">`;
  const html = quote + `<blockquote><img src="https://ci3.googleusercontent.com/proxy#https://tracker.example/open/trk_nested">${encoded}</blockquote>`;
  assert.equal(stripQuotedPigeonboxPixels(html), html.replace(pixel, '').replace(/<img src="https:\/\/ci3[^>]*>/, '').replace(encoded, ''));
});

test('the bundled modern Gmail send processor strips every extra body segment and preserves all other message fields', () => {
  const make = (id, actions) => {
    const msg = Array(56).fill(null); msg[0] = id; msg[7] = 'Subject'; msg[8] = [null, [[0, '<p>New reply</p>'], [2, quote], [1, `<div class="gmail_signature">Signature ${pixel}</div>`, 'metadata']], null, null, null, null, 1]; msg[10] = actions;
    const inner = Array(14).fill(null); inner[13] = [msg];
    return { msg, wrapper: [null, ['thread-a:test', inner]] };
  };
  const sending = make('msg-a:send', ['^all', '^pfg']);
  const unrelatedDraft = make('msg-a:draft', ['^r', '^r_bt']);
  const untouched = JSON.stringify(unrelatedDraft.wrapper);
  const request = [null, [[unrelatedDraft.wrapper, sending.wrapper]]];
  const expected = structuredClone(request);
  const parts = expected[1][0][1][1][1][13][0][8][1];
  parts[0][1] = fresh; parts[1][1] = quote.replace(pixel, ''); parts[2][1] = `<div class="gmail_signature">Signature </div>`;
  const result = sdk.replaceBodyContentInSendRequestBody(request, fresh);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.equal(JSON.stringify(unrelatedDraft.wrapper), untouched);
  assert.equal(JSON.stringify(sending.msg[8]).match(/\/open\/trk_/g)?.length, 1);
});

test('the legacy Gmail send processor preserves segment metadata and strips quoted pixels even when the new reply is untracked', () => {
  const send = Array(12).fill(null); send[1] = 'msg-a:send'; send[9] = [null, null, [[null, 0, 'typed'], [null, 2, quote, 'metadata']]]; send[11] = ['^pfg'];
  const wrapper = Array(15).fill(null); wrapper[14] = [null, send];
  const update = [null, null, [null, null, wrapper]];
  const request = { 2: [null, [update]] };
  const expected = structuredClone(request);
  const parts = expected[2][1][0][2][2][14][1][9][2]; parts[0][2] = '<p>Untracked reply</p>'; parts[1][2] = quote.replace(pixel, '');
  const result = JSON.parse(sdk.replaceEmailBodyForSendRequest(JSON.stringify(request), '<p>Untracked reply</p>'));
  assert.deepEqual(result, expected);
  const empty = JSON.parse(sdk.replaceEmailBodyForSendRequest(JSON.stringify(request), ''));
  const emptyParts = empty[2][1][0][2][2][14][1][9][2];
  assert.equal(emptyParts[0][2], '');
  assert.equal(emptyParts[1][2], quote.replace(pixel, ''));
});

test('fails the build when an InboxSDK update changes the send boundary', () => {
  assert.throws(() => patchInboxSdkPageWorld(original.replace('  msg[8][1][0][1] = newBodyHtmlContent;', '  changed();')), /layout changed/);
  assert.throws(() => patchInboxSdkPageWorld(patched), /layout changed/);
});
