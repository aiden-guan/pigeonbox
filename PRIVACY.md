# PigeonBox Privacy Policy

Effective October 5, 2026. Applies to the PigeonBox Chrome extension, including the version on the Chrome Web Store and builds from this repository.

PigeonBox reads the Gmail page you already have open so it can sort, summarize and search your mail, draft replies you review, and tell you when a tracked email was opened. Local does not use the Gmail API or request Google OAuth access. The same extension includes optional Cloud mode, which can connect Google with your explicit authorization. PigeonBox does not read your Google cookies.

The short version: **by default everything stays in your browser.** Email content leaves your computer only when you choose a service that needs it, and only to that service.

## What PigeonBox handles

| Data | Why | Where it is kept |
|---|---|---|
| Email content visible in Gmail (subjects, senders, recipients, dates, message text) | Sorting, summaries, search, Ask Pigeon, reply drafts | In your browser (IndexedDB), on your computer |
| Your Gmail address and display name, read from the page | Knowing which messages are yours and signing drafts | In your browser (`chrome.storage.local`) |
| Settings, API keys and tracker tokens you enter | Running the features you turn on | In your browser (`chrome.storage.local`), readable only by the extension's own pages and background worker |
| Tracked-email records (see Tracking) | Showing opens and clicks | On the tracker you choose, and a copy in your browser |

Optional product analytics are off by default and can be enabled in Settings. They record feature events, never message content, addresses, prompts or provider keys. PigeonBox has no advertising.

## When data leaves your computer

Only in these cases, each of which you turn on yourself:

- **AI on this computer** (downloaded model, Chrome's built-in Gemini Nano, or Ollama on `localhost`): email content is processed on your computer and sent nowhere. Downloading a model fetches its files from Hugging Face, which sees your IP address. No email content is sent.
- **Your own AI provider (bring your own key)**: the email content needed for the task you asked for is sent to the endpoint you entered, under your account with that provider and its terms.
- **Open and click tracking** (off until you set up a tracker): see Tracking.
- **PigeonBox Cloud** (when available, and only after you explicitly choose it in Settings): email content needed for a request is sent over TLS to the PigeonBox Cloud API, processed by its AI provider, and returned. Cloud does not log email content. It stores account details, subscription status, usage counts and encrypted derived intelligence including summaries, commitments and prepared drafts. Retaining encrypted message excerpts for Fast Recall requires a separate opt-in and retention setting. Payments are handled by Stripe.
- **Real-time Pidgy checks** (Cloud only, off by default): after you opt in, a relevant changed clause of at most 700 characters may be checked against trusted Brain and calendar context. Raw unsent clauses are ephemeral: they are not saved as memory, logged, embedded or placed in durable jobs. Ordinary prose does not trigger a check.
- **Update checks** (off by default): PigeonBox asks GitHub for the latest release. No email or settings data is sent; GitHub sees your IP address. Copies installed from the Chrome Web Store are updated by Chrome instead.

PigeonBox never switches between these on its own. If a service you chose is unavailable, the request fails with a message. Nothing is sent to a different provider.

## Cloud waitlist

The website offers an optional [Cloud waitlist](https://usepigeonbox.com/waitlist). Opening it does not enable Cloud or authorize Gmail access. Submitting the form sends only your email address, signup source (website or extension), and signup time to the PigeonBox backend. The normalized email is stored once in Supabase, accessible only to the backend and project administrators, for Cloud launch access. We send no automatic email. Rate limiting uses a salted hash of your IP address, not the raw address. Signups are retained until launch access is handled or you request removal through the contact below.

## Tracking

Tracking is optional and separate from AI. When you send a tracked email, PigeonBox adds a tracking image and, if you enable it, rewrites links. The tracker you connect (one you host, such as your own Convex or Cloudflare deployment, or PigeonBox Cloud's in Cloud mode) stores, for each tracked email: subject, sender, recipients, Gmail IDs, and sent time. For each open or click it stores: time, user agent, a salted hash of the IP address, a classification (for example "likely a mail proxy"), and for clicks, the link destination. The tracker never receives message bodies.

Tracking IDs are random and reveal nothing about your mailbox. An open is a signal that an image loaded, not proof the message was read.

## What PigeonBox does not do

- It does not sell or transfer your data to third parties, except to the providers you choose above, to run the feature you asked for.
- It does not use or transfer your data for purposes unrelated to PigeonBox's single purpose: inbox intelligence and open tracking for Gmail.
- It does not use or transfer your data to determine creditworthiness or for lending.
- It does not send email for you. Drafts open in Gmail for you to review and send yourself.

PigeonBox's use of the data it handles complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Keeping and deleting data

Data in your browser stays until you remove it. **Settings → Privacy & data → Clear local mail index** deletes the mail index, and uninstalling PigeonBox removes everything it stored in Chrome. Tracking records on a tracker you host live in your own deployment, and you delete them there. A PigeonBox Cloud account can be deleted from its account page, which removes the account and the tracking records and usage history kept for it.

## Children

PigeonBox is not directed at children under 13 and does not knowingly collect their data.

## Changes

Changes to this policy are published in this file, and the history is visible in the repository. Material changes are noted in the [changelog](CHANGELOG.md).

## Contact

Questions: open an issue at [github.com/aiden-guan/pigeonbox/issues](https://github.com/aiden-guan/pigeonbox/issues). Security reports: see [SECURITY.md](SECURITY.md).

Technical detail on every data flow is in [docs/privacy-model.md](docs/privacy-model.md) and [docs/tracking.md](docs/tracking.md).
