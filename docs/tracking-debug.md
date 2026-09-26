# Tracking debug

This is the acceptance test for open and link tracking. A green unit test is not enough. The stored Gmail message has to contain the pixel.

## What success looks like

Gmail Sent → **Show original** contains exactly one image whose `src` includes `/open/trk_`, and that id is the one allocated for the send. Opening the message in another account or client then creates an OPEN event. Clicking a rewritten link goes to the original URL and creates a CLICK event.

Composing must not request `/open/trk_`. The pixel is added only to the outbound send body.

## Setup

1. Load the unpacked extension from `apps/extension/dist`.
2. For recipient opens across devices, use a public tracker: your Convex deployment or Cloudflare Worker + Supabase. `npm run tracker` is local development only; another device cannot reach the `127.0.0.1` address.
3. Open the extension **Settings → Email tracking**.
4. Paste the tracker URL and personal API token into Settings. Get the public URL from your Convex or Cloudflare deployment; `.local/tracker.txt` contains the generated token. For local-only development, use `http://127.0.0.1:8787` on the same computer. You may place a gitignored `apps/extension/public/tracker-config.json` (`{ "trackerBaseUrl", "personalApiToken" }`) to prefill them; release packaging always strips that file. A token inside an extension is readable by anyone with the browser profile, so it only protects your own tracker.
5. Save and allow Chrome's permission prompt for the tracker host. The connection line should say **Tracker healthy**, not merely that the fields are filled in.
6. Leave **Track email opens** and **Track link clicks** on.

## Send and inspect MIME

1. In Gmail, compose a new message to an account you can open separately.
2. Use a unique subject, for example `Tracking proof 2026-09-23-a`.
3. Include one normal `https://` link, your signature, and any reply or forward quote you care about.
4. Wait until the compose control says **Tracking ready**. That means a tracker record exists and InboxSDK accepted the send-request modifier. It does not mean the pixel is in the compose box.
5. Send. The message should go out without a visible delay.
6. Open **Sent**, open that message, and choose **Show original** (⋮ → Show original).
7. Search the raw message for `/open/trk_`.

Expected:

- One `<img>` whose `src` contains `/open/trk_<id>`.
- The same id is not repeated.
- The `https://` link is rewritten to `/c/clk_...`.
- `mailto:`, `tel:`, and the signature text are still there.
- No API token, recipient, subject, or Gmail id is in the pixel URL.

Or save the original as `.eml` and run:

```bash
npm run verify:tracking -- path/to/message.eml
```

Expected:

```text
Tracking pixel found: YES
Tracking ID: trk_...
Pixel count: 1
Tracked links: 1
```

`Tracking pixel found: NO` means the send request was not rewritten. Continue below. Do not debug open counts until this passes.

## Open and click

1. Open the same message from the other account or a mail client that loads images.
2. Tracker logs, or `GET /api/emails/:trackingId/events` with the bearer token, should show an OPEN.
3. `open_count` becomes 1, `first_opened_at` is set once, and `last_opened_at` updates.
4. In Gmail, the sent row should change from **Sent** to **Opened** after the next tracking poll (about a minute in the background, sooner while the Gmail tab is open).
5. Click the tracked link. It should land on the original URL and increment `click_count`.

A fetch that happens before Gmail confirms send is stored as `SELF_LIKELY` and does not increment `open_count`.

## If the pixel is missing

Run **Settings → Run diagnostics** after the send. The tracking block is the source of truth:

| Line | Meaning |
| --- | --- |
| allocation: no | Tracker record was not created. Check the connection status. |
| draft ID: no | Gmail had not saved a draft id, so InboxSDK could not bind a modifier. |
| modifier registered: no | `registerRequestModifier` threw, usually `keyId should be set here`. |
| modifier invoked: no | The modifier was registered but Gmail’s send did not hit it. |
| pixel returned in outbound HTML: no | The modifier ran and returned the original body. |
| Gmail sent event: no | InboxSDK never confirmed send, so the record stays `PENDING`. |

If the modifier was registered and Gmail sent, but it was never invoked, diagnostics say:

```text
Tracking injection failed:
InboxSDK request modifier was registered but was never invoked for Gmail send.
```

The extension log (`[tracking]`) records the same steps: `session-created`, `allocation-success`, `draft-ready`, `modifier-register-success`, `modifier-invoked`, `modifier-transformed`, `sent`, `backend-linked`.

## How injection works

Gmail’s current send is a sync request. InboxSDK’s page world rewrites the HTML at `msg[8][1][0][1]` only when a modifier was registered for the draft id in `input[name="draft"]` (the `msg-a:` prefix is stripped). The isolated-world listener is bound to the first id it saw. A second registration under a later draft id is not used, and it can hang the send, so this extension does not rebind.

The compose DOM is not the message Gmail stores. The modifier return value is.

Page world is injected by InboxSDK’s own `inboxsdk__injectPageWorld` message. The extension does not inject it earlier.

## Limits

- **Plain text.** InboxSDK’s current sync send path does not accept a conversion from plain text to HTML. Those sends are left unchanged and the session records why.
- **Scheduled send.** The record stays pending until Gmail fires `sent`. The schedule menu is not treated as a send.
- **Undo send.** `sentAt` is set only in the `sent` handler. `sendCanceled` returns the session to ready.
- **Discard.** A discarded compose marks the tracker `CANCELLED`. It is not a sent email.
- **Tracker down.** Send still goes out. The session records the failure.
- **Id formats.** Stored Gmail ids strip a leading `#` and `msg-a:`, `msg-f:`, `thread-a:`, or `thread-f:`. The modifier key only strips `#` and `msg-a:`, matching page world.
- **Supabase.** Apply `supabase/migrations/20260923000000_tracking_status.sql` as well as the original tracking migration. `sent_at` is nullable and `status` is `PENDING` until send.
