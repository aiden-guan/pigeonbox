# PigeonBox Privacy Policy

Effective October 29, 2026. Applies to the PigeonBox Chrome extension (builds from this repository, the GitHub release ZIP and any Chrome Web Store copy) and to the PigeonBox server in this repository when you run it yourself.

PigeonBox reads the Gmail page you already have open so it can sort, summarize and search your mail, draft replies you review, and tell you when a tracked email was opened. On this computer it does not use the Gmail API or request Google OAuth access. A PigeonBox server you run can connect Google with your explicit authorization. PigeonBox does not read your Google cookies.

The short version: **there is no PigeonBox-operated service.** No one behind PigeonBox receives your email, settings or usage. By default your mail stays in your browser. Email content leaves your computer only when you choose a service that needs it, and only to that service, which you set up yourself.

## What PigeonBox handles

| Data | Why | Where it is kept |
|---|---|---|
| Email content visible in Gmail (subjects, senders, recipients, dates, message text) | Sorting, summaries, search, Ask Pigeon, reply drafts | In your browser (IndexedDB), on your computer |
| Your Gmail address and display name, read from the page | Knowing which messages are yours and signing drafts | In your browser (`chrome.storage.local`) |
| Settings, API keys and tracker tokens you enter | Running the features you turn on | In your browser (`chrome.storage.local`), readable only by the extension's own pages and background worker |
| Tracked-email records (see Tracking) | Showing opens and clicks | On the tracker you choose, and a copy in your browser |

PigeonBox has no usage analytics and no advertising.

## When data leaves your computer

Only in these cases, each of which you turn on yourself:

- **AI on this computer** (downloaded model, Chrome's built-in Gemini Nano, or Ollama on `localhost`): email content is processed on your computer and sent nowhere. Downloading a model fetches its files from Hugging Face, which sees your IP address. No email content is sent.
- **Your own AI provider (bring your own key)**: the email content needed for the task you asked for is sent to the endpoint you entered, under your account with that provider and its terms.
- **Open and click tracking**: see Tracking.
- **Your PigeonBox server** (only if you, or someone you trust, runs one, and only after you explicitly choose it in Settings): email content needed for a request is sent over TLS to that server (Cloudflare Workers in the operator's Cloudflare account), processed by the AI provider configured on it, and returned. The server does not log email content. It stores your account (the email address you sign in with), usage counts for its limits, and, if you connect Google, mail metadata and encrypted derived data such as summaries, commitments and prepared drafts, in the operator's Supabase project. Retaining encrypted message excerpts for Fast Recall requires a separate opt-in and retention setting. Connecting Google lets the server read your mail through the Gmail API and, with the permissions you grant, create drafts, organize mail, use your calendar, or send messages you approved. Whoever operates the server can access what it stores.
- **Real-time Pidgy checks** (server mode only, off by default): after you opt in, a relevant changed clause of at most 700 characters may be checked against context your server already holds and your calendar. Raw unsent clauses are ephemeral: they are not saved as memory, logged or placed in durable jobs. Accepted context statements may create a temporary query embedding through the server's AI provider; neither the clause nor its vector is stored. One small model judgment receives selected evidence only. Ordinary prose does not trigger a check.
- **Server client settings** (server mode only): PigeonBox asks your server for its current client settings, such as how long to wait after typing and which extension versions it supports. The request carries no account, email or settings data. Local mode never makes it.
- **Update checks** (off by default): PigeonBox asks GitHub for the latest release. No email or settings data is sent; GitHub sees your IP address. Copies installed from the Chrome Web Store are updated by Chrome instead.

**Copy diagnostics** (Settings → Advanced) puts a short troubleshooting summary on your clipboard: version numbers, mode, connection states and recent error codes. It contains no email content, addresses or IDs, is kept only for the current browser session, and is never sent anywhere unless you paste it yourself.

PigeonBox never switches between these on its own. If a service you chose is unavailable, the request fails with a message. Nothing is sent to a different provider.

## Tracking

Tracking is optional and separate from AI. When you send a tracked email, PigeonBox adds a tracking image and, if you enable it, rewrites links. The tracker is always one you run: your PigeonBox server's tracker, or a standalone tracker in your own Convex or Cloudflare account. When a server is configured, its tracker is used unless you turn on **Local-only** in tracking settings; tracking then uses a standalone tracker you set up, or stays off. Whichever tracker you use stores, for each tracked email: subject, sender, recipients, Gmail IDs, and sent time. For each open or click it stores: time, user agent, a salted hash of the IP address, a classification (for example "likely a mail proxy"), and for clicks, the link destination. The tracker never receives message bodies.

Tracking IDs are random and reveal nothing about your mailbox. An open is a signal that an image loaded, not proof the message was read.

## What PigeonBox does not do

- It does not sell or transfer your data to third parties, except to the providers you choose above, to run the feature you asked for.
- It does not use or transfer your data for purposes unrelated to PigeonBox's single purpose: inbox intelligence and open tracking for Gmail.
- It does not use or transfer your data to determine creditworthiness or for lending.
- It does not send email on its own. In the extension, drafts open in Gmail for you to review and send yourself; a PigeonBox server sends only a message you approved in its approval queue.

PigeonBox's use of the data it handles complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Keeping and deleting data

Data in your browser stays until you remove it. **Settings → Privacy & data → Clear local mail index** deletes the mail index, and uninstalling PigeonBox removes everything it stored in Chrome. Tracking records on a standalone tracker live in your own deployment, and you delete them there. An account on a PigeonBox server can be deleted from that server's dashboard, which removes the account and everything the server stored for it; the server's operator can also delete it directly.

## Children

PigeonBox is not directed at children under 13 and does not knowingly collect their data.

## Changes

Changes to this policy are published in this file, and the history is visible in the repository. Material changes are noted in the [changelog](CHANGELOG.md).

## Contact

Questions: open an issue at [github.com/aiden-guan/pigeonbox/issues](https://github.com/aiden-guan/pigeonbox/issues). Security reports: see [SECURITY.md](SECURITY.md).

Technical detail on every data flow is in [docs/privacy-model.md](docs/privacy-model.md) and [docs/tracking.md](docs/tracking.md). Running a server: [docs/self-hosting.md](docs/self-hosting.md).
