# Privacy model

PigeonBox reads the Gmail web page you already have open. On this computer (Local mode) it does not use the Gmail API, OAuth scopes for your mailbox, or your Google cookies. A PigeonBox server you run can additionally connect Google with your explicit authorization.

No PigeonBox-operated service receives anything. Data goes only to services you configure: your AI provider, your own server (your Supabase project and Cloudflare account), Google's APIs when you connect Gmail to that server, and your tracker. What happens to email content depends on how you choose to run it.

## Where email content goes

| Configuration | Email content used for AI goes to | Stored by PigeonBox |
|---|---|---|
| **Local, AI off** | Nowhere. On-device rules sort mail. | IndexedDB in your browser |
| **Local, downloaded model** | Nowhere. The model runs on WebGPU in the extension. | IndexedDB; model weights in the browser's private file system |
| **Local, Chrome Gemini Nano** | Nowhere. Chrome runs the model on-device. | IndexedDB |
| **Local, Ollama on this computer** | Your Ollama server on `127.0.0.1` | IndexedDB |
| **Local, your API key (BYOK)** | The provider whose endpoint you entered, under your account and its terms | IndexedDB |
| **Local, ChatGPT web session** (experimental, not in release builds) | chatgpt.com, as temporary chats under your account | IndexedDB |
| **Your PigeonBox server** | Your server over TLS, then the AI provider configured on it | IndexedDB locally. The server does not store the email content it processes for AI requests |

Choosing server mode requires an explicit agreement in Settings. PigeonBox never switches between these on its own. If the server is unavailable, requests fail with a clear message and **nothing is sent to another provider**; on-device rules keep working.

## Server AI processing

Server AI works as: extension → authenticated server API (your Cloudflare Worker) → your AI provider → response. The API:

- does not persist request or response bodies,
- does not log email content (only operational metadata: operation, model, provider, token counts, latency, status, request ID),
- with Cloudflare AI Gateway as the provider, asks the gateway not to log payloads and not to cache mailbox prompts,
- records usage for its limits without any email text.

Who can use a server is decided by its `ALLOWED_EMAILS` list. Whoever operates the server can read what it stores (see below) for every account on it.

## Always-on Gmail (optional Google connection)

Using server AI never stores mailbox data. The always-on features are a separate opt-in, available when the server is configured for them: the person connects a Google account to the server (from the dashboard or the extension's settings) and chooses the permissions (read mail, create drafts, organize, read or write the calendar, send). Each can be added later with Google's incremental consent, or removed by disconnecting.

With a connection, the server:

- reads mail through the Gmail API to keep thread state, follow-ups and prepared drafts current, reacting to Gmail push notifications;
- stores **metadata** (Gmail IDs, dates, senders and recipients, labels, subject lines) and **encrypted derived data** (summaries, commitments, drafts, notes, approval previews) in your Supabase database with AES-256-GCM under per-purpose keys; it does not store message bodies;
- keeps encrypted **message excerpts only with Fast Recall**, an opt-in with a retention the person chooses; turning it off deletes them;
- keeps the Google refresh credential **encrypted in that database**. It is never sent to the extension, the browser or the dashboard;
- never sends email or invitations without the person approving that exact message in the approval queue;
- treats email content as untrusted data: instructions inside an email are flagged and not followed, and drafts are checked so unsupported facts become placeholders.

The extension only shows this state. In server mode with a connection, the background worker fetches thread intelligence for the thread card; Gmail's content script can request that read-only view and nothing else. Approving, connecting and every other server action happen in extension pages or the dashboard. Local mode never contacts the server for mail or thread data, not even thread IDs; the one exception is tracking, described below.

Everything synced can be deleted from the dashboard (Privacy & data), per account by disconnecting, or entirely by deleting the account.

## Real-time Pidgy checks (optional, server mode)

Off by default, and separate from memory learning. With **Real-time Pidgy checks** turned on in Memory settings, Pidgy can point out that something you are writing conflicts with or overlooks reliable personal context your server already knows ("You have Math 52 from 2–4 PM tomorrow"). This is the one server feature that looks at text before you send it, so its limits are deliberate:

- **Most typing sends nothing.** After you pause, on-device rules look only at the sentence you just changed. Availability, promises, deadlines, status, uncertainty, prior discussions and negative statements about upcoming events can qualify; ordinary prose, quoted replies and signatures never do.
- **Only a short phrase leaves the page.** A check carries at most 700 characters of that sentence, plus the subject, recipient addresses and thread ID. Never the whole draft.
- **The worker decides.** Gmail's content script hands the phrase to the extension's background worker, which sends it to your server only in server mode and only after confirming the setting is on. In Local mode it is never sent anywhere. No credentials reach the Gmail page.
- **Processed ephemerally.** The server compares the phrase with your Google Calendar free/busy and individual self/person/topic facts, commitments, current conversation summaries, user notes, relevant interaction history and fresh future calendar metadata (optional Fast Recall excerpts only when enabled), returns at most one short advisory, and discards the phrase. It is not written to any table or job queue, not included in logs, usage or audit records, and never becomes a memory. Accepted context statements can be turned into a temporary query vector by the server's AI provider to search existing context; that vector is not stored. When the rules cannot decide, the phrase and a few pieces of supporting context may go to the server's AI provider for one bounded judgment, under the same terms as other server AI. Calendar availability and clear structured conflicts need no model. A returned semantic message must copy a complete selected source sentence or a server-rendered calendar fact; source ownership, versions, exclusions and freshness are rechecked after inference. Sensitive content is rejected, and every failure stays silent.
- **Kept briefly in the browser's memory only.** The extension remembers recent answers for the open compose window (30 seconds by default; remote client config can shorten it) so it does not ask twice; nothing is written to browser storage, and closing the compose clears it. Forgetting or correcting a memory, changing a connection or preference, or a new client config revision drops every remembered answer at once. Dismissals stay in that window only.
- **Always the right account.** A check names the Gmail account it was written in and is not sent when that is unknown, so the server never answers from another connected account's context.
- **Never in the way.** Checks never delay or block typing or sending, and any failure is silent.

Mail you actually send is handled as before: sent-mail learning applies only to sent mail, and only when its own setting is on. Turning Real-time Pidgy checks off stops all checks immediately.

## Tracking

Tracking is separate from AI. A tracker (your standalone tracker, or your server's tracker) stores per tracked email: subject, sender, recipients, Gmail IDs, sent time, and open/click events with user agent, a salted IP hash and a classification. It never receives message bodies. Tracking IDs in pixels and links are random and reveal nothing about the mailbox. When a server is configured, tracking uses its tracker in both modes unless **Local-only** is turned on in tracking settings; then it uses a standalone tracker you set up, or stays off. See [tracking.md](tracking.md).

## Optional standalone trackers

A Convex deployment you connect stores only the tracking data above, in your own Convex project. See [convex-self-hosting.md](convex-self-hosting.md). The Cloudflare Worker + Supabase tracker stores the same data in your own Supabase project. See [tracker-cloudflare.md](tracker-cloudflare.md).

## Other requests

- **Model downloads** fetch weights from Hugging Face when you click Download; Hugging Face sees your IP address, no email content is sent.
- **Update checks** (off by default, unpacked installs only) ask the GitHub API for the latest release; GitHub sees your IP address.
- **Remote client config** (server mode only) asks your server for its client settings; the request carries no account, email or settings data.

## Secrets on your device

- API keys and tracker tokens live in `chrome.storage.local`, restricted to extension pages and the service worker. Gmail's page and PigeonBox's content script cannot read them.
- The server refresh token is stored the same way; the short-lived access token stays in memory and session storage.
- The extension ships no server secrets. Release builds are scanned for credentials before packaging.

## Deleting data

- Settings → Privacy & data → **Clear local mail index** removes the IndexedDB index.
- Removing the extension deletes all of its local storage and downloaded models.
- Standalone tracker data lives in your tracker; delete it there.
- Server account data is removed by deleting the account from the dashboard. The server's operator can also delete it directly in Supabase.
