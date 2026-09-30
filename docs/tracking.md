# Open and click tracking

Tracking is optional and independent of AI. It never sees mailbox bodies.

For recipient opens from another device, use a public HTTPS tracker you own, such as Convex or Cloudflare Worker + Supabase. `npm run tracker` listens on this computer only and is for local development.

## How it works

1. In a Gmail compose window, the content script asks the service worker to create a tracked email. The worker calls the tracker's `POST /api/emails` and gets a random `trk_…` ID, a pixel URL and rewritten link URLs.
2. When you send, the pixel and rewritten links are added to **Gmail's outbound send request** through InboxSDK, not to the compose box, so composing never loads the pixel. If anything fails, the mail is sent untracked; tracking never blocks Send.
3. A recipient's mail client fetches `GET /open/:id` (a 1×1 GIF) and link clicks go through `GET /c/:id` (302 to the original `http(s)` URL).
4. The worker polls the tracker, updates sent-mail badges in Gmail, and shows notifications.

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

All four speak the same protocol and report `protocolVersion: 3` on `/health`. The Cloud tracker runs the same request handler as `workers/tracker` (`handleTrackerRequest`) with a per-user store.

## Accuracy

"Open detected" means a counted pixel fetch happened. Apple Mail Privacy Protection preloads images (false opens); many clients block images (missed opens); corporate scanners fetch links. PigeonBox never claims a message was read.

A message sent to several people (To, Cc or Bcc) is one message with one pixel, so an open can't be attributed to a particular recipient. Alerts name the group ("One of a@x, b@y or 2 others opened …") and, when the user agent shows it, the mail app ("in Gmail", "in Outlook").

## Verifying a real send

Follow [tracking-debug.md](tracking-debug.md): send to another account, check **Show original** for exactly one `/open/trk_` image, open it elsewhere, and confirm one open is counted.
