import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectTrackingMime } from './tracking-mime.mjs';

const html = '<p>Test</p><a href="https://tracker.test/c/clk_link">Link</a><img src="https://tracker.test/open/trk_test" width="1" height="1">';
const expected = { pixelCount: 1, trackedLinks: 1, trackingIds: ['trk_test'] };
test('plain HTML and unencoded HTML MIME exports', () => {
  assert.deepEqual(inspectTrackingMime(html), expected);
  assert.deepEqual(inspectTrackingMime(`Content-Type: text/html; charset="utf-8"\r\n\r\n${html}`), expected);
});
test('Gmail quoted-printable attributes and soft URL line wrapping', () => {
  const encoded = html.replaceAll('=', '=3D').replace('/open/', '/op=\r\nen/');
  assert.deepEqual(inspectTrackingMime(`MIME-Version: 1.0\r\nContent-Type: multipart/alternative;\r\n boundary="gmail-boundary"\r\n\r\n--gmail-boundary\r\nContent-Type: text/plain\r\n\r\nNo HTML pixel here.\r\n--gmail-boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encoded}\r\n--gmail-boundary--\r\n`), expected);
});
test('nested base64 HTML is decoded and HTML attachments do not inflate counts', () => {
  const raw = `Content-Type: multipart/mixed; boundary=outer\n\n--outer\nContent-Type: multipart/alternative; boundary=inner\n\n--inner\nContent-Type: text/html\nContent-Transfer-Encoding: base64\n\n${Buffer.from(html).toString('base64')}\n--inner--\n--outer\nContent-Type: text/html\nContent-Disposition: attachment; filename=other.html\n\n${html}\n--outer--\n`;
  assert.deepEqual(inspectTrackingMime(raw), expected);
});
test('plain text does not falsely count literal markup; malformed MIME fails explicitly', () => {
  assert.equal(inspectTrackingMime(`Content-Type: text/plain\n\n${html}`).pixelCount, 0);
  assert.throws(() => inspectTrackingMime('Content-Type: multipart/mixed\n\ninvalid'), /boundary/);
  assert.throws(() => inspectTrackingMime('Content-Type: text/html\nContent-Transfer-Encoding: base64\n\n%%%'), /base64/);
});
