# Open and click tracking

Tracking is optional and independent of AI. It never sees mailbox bodies.

For recipient opens from another device, use a public HTTPS tracker you own, such as Convex or Cloudflare Worker + Supabase. `npm run tracker` listens on this computer only and is for local development.

## How it works

1. In a Gmail compose window, once there is a recipient, the content script asks the service worker to create a tracked email. The worker calls the tracker's `POST /api/emails` and gets a random `trk_…` ID and a pixel URL. One compose gets one tracking ID: recipient and subject edits, draft saves and repeated Gmail events reuse it. Discarding the compose marks it `CANCELLED`.
2. When you send, the pixel and tracked links are added to **Gmail's outbound send request** through InboxSDK, not to the compose box, so composing never loads the pixel. Each `http(s)` link gets a stable `clk_…` ID; the request modifier stores those IDs on the tracker and rewrites a link only after the tracker confirms it (within 4 seconds), so a recipient never gets a link that leads to an error. The rewrite is idempotent: a second pass adds no second pixel and no new link IDs. If anything fails, the mail is sent untracked (or with the pixel but plain links); tracking never blocks Send. Plain-text sends are left untracked.
3. A recipient's mail client fetches `GET /open/:id` (a 1×1 GIF) and link clicks go through `GET /c/:id` (302 to the stored `http(s)` URL). Unknown or malformed IDs get the same GIF, or a plain "not available" page for links; there is no redirect without a stored link.
4. The worker polls the tracker, updates sent-mail marks in Gmail (○ sent, ✓ opened, ↗ link clicked) and the detail card's activity list, and shows notifications.
5. Each tracked email remembers which tracker issued it (`local:<tracker origin>` or `cloud:<API origin>`). Updates, self-view claims and activity for that email go only to that tracker, so switching between Local and Cloud never sends an ID to the wrong one. Cloud is keyed by its API, so a new hosted-tracker hostname keeps existing emails working.

## Telling your own views from recipients (protocol v3)

Gmail loads images in your own Sent view and prefetches through its image proxy, which would otherwise look like opens. The tracker classifies each fetch as `RECIPIENT_LIKELY`, `SELF_LIKELY`, `PROXY_LIKELY`, `MACHINE_LIKELY` or `UNKNOWN`:

- **Self-view claims**: when you open your own sent message, the extension posts a short-lived claim (`/api/emails/:id/self-view`) bound to that exact message and to a fingerprint of your browser (salted IP hash + user-agent family). The next matching pixel fetch consumes the claim and is not counted.
- **Delivery prefetch**: `GoogleImageProxy` fetches within 20 seconds of sending are not opens. Gmail renders the message in your own session as it sends (even if it takes you straight back to the inbox), and prefetches it on delivery to a recipient who has Gmail open.
- **Gmail image proxy**: `GoogleImageProxy` fetches are handled with one-shot proxy suppression tied to your self-view, and page reloads re-arm it.
- **Quoted pixels**: replies and forwards drop earlier tracking pixels from the quote before sending. Mail that already carries one (older replies, or someone else's reply quoting yours) still loads it; when you view such a message the extension posts a claim for each quoted pixel with `quotedRender: true`, and Convex also reclassifies a proxy render of it that beat the claim.
- **Machines**: known scanners and bots are not opens.

The logic lives in `packages/tracking/src/lifecycle.ts` (client), `workers/tracker/src/helpers.ts` (Worker) and `convex/openRequest.ts` (Convex), with regression matrices in each package's tests. Treat any change there as high risk and run the full suite.

## Backends

| Backend | Where | Auth |
|---|---|---|
| `npm run tracker` | This computer, memory by default | Personal token |
| Cloudflare Worker + Supabase | Your accounts | Personal token |
| Convex | Your Convex deployment | Personal token |
| PigeonBox Cloud tracker | PigeonBox | Cloud access token; records scoped to your account |

All four speak the same protocol and report `protocolVersion: 3` on `/health`. The Cloud tracker runs the same request handler as `workers/tracker` (`handleTrackerRequest`) with a per-user store. It records pixel and click events after responding (`TrackerDeps.defer`), so image loads and redirects never wait on the database. A Cloud access token that expires is refreshed through the Cloud session and the request retried once; a 401 is rejected before any work, so the retry cannot create a duplicate.

Counters (`open_count`, `click_count`, first and last times) are always recomputed from the email's stored events, up to 5,000 per email, never incremented. That keeps them correct when a later self-view claim reclassifies an earlier fetch.

## Accuracy

"Open detected" means a counted pixel fetch happened. Apple Mail Privacy Protection preloads images (false opens); many clients block images (missed opens); corporate scanners fetch links. PigeonBox never claims a message was read.

A message sent to several people (To, Cc or Bcc) is one message with one pixel, so an open can't be attributed to a particular recipient. Status text and alerts therefore name the email, never a reader ("Open detected for “Plan”", "A link was clicked in “Plan”"), and the detail card says when one pixel was shared by several recipients. Alerts are grouped per email per poll and never fire for self, machine or unknown fetches.

## Verifying a real send

Follow [tracking-debug.md](tracking-debug.md): send to another account, check **Show original** for exactly one `/open/trk_` image, open it elsewhere, and confirm one open is counted.
