# Content-free product analytics

PigeonBox measures installs, activation, retention, conversion and the "Sent with PigeonBox" footer loop with events that carry no mail content. This page lists exactly what is sent. Code: `apps/extension/src/ui/analytics.ts` here; `packages/server/src/product-analytics.ts` and `apps/web/public/lib/page-analytics.js` in pigeonbox-cloud.

## Extension

**On by default, with disclosure.** The last onboarding step and Settings → Privacy & data (also the dashboard's Settings → Privacy) show a "Share anonymous usage events" switch. Turning it off stops sending immediately and deletes the install ID, the local counters and the active-day marker; turning it back on creates a new install ID, so old and new activity cannot be linked. Core behavior never depends on telemetry, and sending failures are ignored.

Each event is one `POST {Cloud API}/v1/events` from the service worker, with `credentials: 'omit'`. The body is rebuilt from fixed fields just before sending, so nothing else a caller passes can be included:

```json
{ "installId": "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e", "event": "footer_sent", "metadata": { "surface": "gmail", "mode": "local" }, "version": "0.8.1" }
```

- `installId`: a random UUID made with `crypto.randomUUID()` on first use and kept in `chrome.storage.local` (`productAnalyticsInstallId`). It is not derived from, or sent with, the Google account, the PigeonBox account, the browser or the device.
- `event`: one of extension_installed, extension_active, onboarding_started, onboarding_completed, local_selected, cloud_preview_opened, cloud_selected, cloud_signin_started, cloud_signin_completed, google_connection_started, google_connection_completed, first_cloud_sync_completed, first_cloud_overview_viewed, first_prepared_draft_seen, prepared_draft_used, first_briefing_viewed, first_approval_decided, first_tracked_email_created, first_open_received, smart_view_created, automation_created, automation_activated, command_palette_opened, ask_pigeon_used, tracked_document_created, settings_opened, footer_added, footer_removed, footer_sent, snippet_used, send_later_opened, remind_on_send, keyboard_shortcut_used, hosted_tracking_signin, upgrade_clicked. Unknown names are dropped in the extension and refused by the server.
- `metadata`: only these keys and values: surface (workspace/sidepanel/gmail/onboarding/settings), mode (local/cloud), outcome (success/failure/denied), latency (fast/normal/slow), capabilityPresent (boolean), source (workspace_header/command_palette). Anything else is discarded.
- `version`: the numeric extension version, or empty.

Never sent: mail bodies, subjects, sender or recipient addresses, names, search or Chat queries, generated text, document names or contents, URLs, Gmail message/thread/draft IDs, tracking IDs, the account ID or email, timestamps beyond the server's receive time.

When events fire: `extension_installed` on a fresh install; `extension_active` at most once per local day (on browser start-up and the minute alarm); `first_*` events once per install (deduplicated by the local counters); `first_tracked_email_created` when the first tracked email is created; `first_open_received` when the first new open arrives for a tracked email; `footer_sent` / `footer_removed` once per Free send, depending on whether the footer was kept. Activation from the Cloud control plane is not inferred client-side; merely previewing or saving a rule never emits activation. First-sync means a connected account reports healthy sync with a completed timestamp; Google completion is recorded after a connection flow returns a connected account.

The extension also keeps bounded local counters `{eventName: count}` (`productEventCounts`), used for the `first_*` deduplication. They hold no other data.

## Cloud (`/v1/events`)

The extension talks only to PigeonBox Cloud. The server validates every event against the same allowlist (strict enums; unknown events, bad enum values and non-UUID install IDs get 400), accepts only `chrome-extension://` origins listed in `ALLOWED_EXTENSION_IDS`, limits each install to 60 events a minute and each (hashed) IP to 300, and forwards the event to PostHog server-side. The request IP is never forwarded: events carry `$ip: null` and `$geoip_disable: true`. Unknown body fields are dropped before forwarding. The PostHog distinct ID is the install ID; properties are the metadata, `version` and `source: "extension"`.

## Server-side account events

Emitted by the Cloud API and tracker with a pseudonymous distinct ID, `acct_` + an HMAC-SHA-256 of the account ID keyed with `ANALYTICS_SALT`. The account ID and email never reach PostHog, and account events are not linked to install IDs.

| Event | When | Properties |
| --- | --- | --- |
| `account_signed_up` | First sign-in within 30 minutes of the identity provider creating the account | `campaign` (`sent_with`, `launch`, `other` or null), `client` (`extension`/`web`) |
| `hosted_tracking_used` | A tracked email is created on the hosted tracker; at most once per account per UTC day | `plan` (`free`/`pro`) |
| `checkout_started` | Checkout session created | — |
| `checkout_completed` | Stripe `checkout.session.completed` | — |
| `plan_changed` | Billing state moves the account between Free and Pro | `from`, `to`, `status` (Stripe status) |
| `subscription_cancel_scheduled` | Cancel at period end turned on | — |
| `subscription_canceled` | Subscription ends | `was` (`pro`/`free`) |

No amounts, Stripe customer or subscription IDs are sent. MRR and churn come from PostHog's Stripe data warehouse source, which reads Stripe directly.

## Dashboard actions (`/v1/events/dashboard`)

When a signed-in person acts in the dashboard, the page (`apps/web/public/lib/dashboard-events.js` in pigeonbox-cloud) posts the event to Cloud with their session. Cloud accepts only the dashboard's own origins, limits each account to 60 events a minute, and records the event under the same keyed account hash as the server-side account events (`acct_…`), with `source: "dashboard"`. No PostHog code runs in the page and nothing is stored in the browser. The page sends nothing under Global Privacy Control or Do Not Track, or when "Share anonymous usage events" is off in the extension.

Each event allows only these properties; unknown ones are dropped, and a known one with another value rejects the event. Labels are lowercase identifiers from fixed product enums (at most 32 characters), counts are whole numbers up to 10,000.

| Event | Properties |
|---|---|
| `approval_decided` | `decision` (approve/reject), `approval_kind` (label), `has_edits` |
| `document_uploaded` | `size_mb` (0–100) |
| `document_link_created` | `has_recipient`, `allows_download`, `has_expiration`, `watermarked` |
| `document_link_revoked` | none |
| `automation_created` | `autonomy` (label), `action_count` |
| `automation_activated` | none |
| `automation_run_requested` | `result_status` (label) |
| `sequence_saved` | `is_new`, `step_count`, `tracks_opens` |
| `sequence_recipients_enrolled` | `added_count`, `suppressed_count`, `invalid_count` |
| `sequence_status_changed` | `status` (label) |
| `google_connection_started` | `feature_count`, `is_reconnect` |
| `sync_pause_changed` | `paused` |
| `sync_resync_requested` | none |
| `google_account_disconnected` | `delete_data` |

## Website (`/v1/events/web`)

`lib/page-analytics.js` runs on usepigeonbox.com and the dashboard. It sets no cookies and uses no localStorage, and it is off when the browser sends Global Privacy Control or Do Not Track. Events: `web_pageview`, `web_install_clicked` (a link to the install page or Chrome Web Store), `web_signin_completed` (dashboard sign-in). The body is the event, the page path (one of `/`, `/local`, `/cloud`, `/pricing`, `/docs`, `/privacy`, `/security`, `/terms`, `/waitlist`, `/dashboard`; anything else becomes `/other`; never the query string or fragment), a referrer category (direct, internal, search, social, webmail, other; the referrer URL itself is not sent), and `utm_source` / `utm_medium` / `utm_campaign` mapped to known values or `other`.

The server accepts only `ALLOWED_WEB_ORIGINS`, limits 60 events per IP a minute, and uses a visitor ID that is an HMAC of the UTC day, the hashed IP and the user agent. It changes every day and is never stored in the browser. Website events are personless in PostHog (`$process_person_profile: false`).

**Footer attribution.** Free emails link to `https://usepigeonbox.com/?utm_source=pigeonbox&utm_medium=email_footer&utm_campaign=sent_with`. When a visit arrives with a known campaign, only the campaign name (`sent_with`) is kept in `sessionStorage` for that tab, so later pageviews in the tab and a dashboard sign-in can carry it. On sign-in the dashboard sends it in the `x-pigeonbox-attribution` header of `POST /v1/auth/token`, and a new account's `account_signed_up` event records `campaign: "sent_with"`.

## Configuration

Set on both Workers (API and tracker), as secrets: `POSTHOG_API_KEY` (the project API key) and `ANALYTICS_SALT` (random, the same value on both so account IDs match). Optional: `POSTHOG_HOST` (default `https://us.i.posthog.com`; use `https://eu.i.posthog.com` for an EU project). Without `POSTHOG_API_KEY` the server forwards nothing and the endpoints still answer 202.

## Dashboard

`npm run analytics:dashboard -- --apply` in pigeonbox-cloud (`scripts/posthog-dashboard.mjs`) creates the "PigeonBox growth" dashboard: weekly installs, activation funnel (install → first tracked email → first open, 14 days), weekly active installs, D7/D30 retention, Free→Pro conversion (30 days), signups/upgrades/cancellations per week, footer keep rate (`footer_sent` ÷ (`footer_sent` + `footer_removed`)), footer click-through (footer-link visitors per 100 footer emails, install clicks and signups from them), MRR and monthly churn from the Stripe source. It needs `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`.

Privacy canary tests cover the extension payload (`analytics.test.ts`) and the server forwarding (`product-analytics.test.ts`).
