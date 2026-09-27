# Architecture

PigeonBox is **one Chrome extension with two execution environments**. The public repository owns the extension, every Gmail integration, all local AI, and a typed client for PigeonBox Cloud. The private `pigeonbox-cloud` repository owns only what exists because PigeonBox operates servers.

> Rule: anything needed to interact with Gmail or run PigeonBox locally is public. Anything that exists because PigeonBox operates hosted production servers is private. The public repository never imports private code; it talks to Cloud over HTTPS using `@pigeonbox/api-contract`.

```
extension (public)
   │
   ├── @pigeonbox/core            run mode + capabilities
   ├── @pigeonbox/ai              AIProvider: on-device, Gemini Nano, Ollama, BYOK
   ├── @pigeonbox/cloud-client ──── HTTPS + @pigeonbox/api-contract ────▶ PigeonBox Cloud API (private)
   └── @pigeonbox/tracking     ──── tracker protocol v3 ─────────────────▶ self-hosted tracker, Convex, or Cloud tracker
```

## Runtime contexts

| Context | File | Trust | Does |
|---|---|---|---|
| Content script (isolated world on `mail.google.com`) | `apps/extension/src/content/index.ts` | Low: runs in Gmail's renderer | Reads Gmail through `packages/gmail`, renders the thread card and chips, sends typed messages to the worker. Never sees keys, tokens or full settings. |
| MAIN world | `apps/extension/src/main-world/index.ts` | None | Intentionally empty. InboxSDK injects its own `pageWorld.js`. |
| Background service worker | `apps/extension/src/background/index.ts` | High | Owns settings, secrets, the Cloud session, the AI provider, the agent loop, tracking calls, IndexedDB. |
| Offscreen document | `apps/extension/src/offscreen/offscreen.ts` | High | Runs WebGPU models (transformers.js + ONNX Runtime Web) and Gemini Nano. |
| Extension pages | `settings`, `popup`, `sidepanel`, `onboarding` | High | UI. Talk to the worker with messages. |

### Message trust

`background/messaging.ts` decides who may send what:

- Extension pages (origin `chrome-extension://<id>`) may send any message.
- Gmail content scripts may send only the Gmail-integration messages they need (ingest, summaries, drafts, tracking lifecycle). Settings writes, Cloud sign-in, run-mode changes, index clearing, Gmail actions and model downloads are refused.
- `chrome.storage.local` and `.session` are set to `TRUSTED_CONTEXTS`, so content scripts cannot read settings (BYOK key, tracker token) or the Cloud refresh token. The worker pushes public settings and tracked-email lists to Gmail tabs with messages instead.

### Cloud intelligence in the extension

`background/cloud-intel.ts` connects the extension to PigeonBox Cloud's always-on service. It is active only in Cloud mode, signed in, with `cloud_mail_sync`; Local mode never calls it.

- `CLOUD_THREAD_INTEL` (the only new content-script message) returns read-only thread state for the thread card: state and next action, deadline, promises, follow-up stage and the prepared draft with its sources and placeholders. Results are batched and cached for 20 seconds (`InflightCache`), and the card renders local data first so Cloud latency never blocks it.
- `CLOUD_CALL` (extension pages only) calls an allowlisted contract route: approvals, Focus Queue, Ask Pigeon, connections and preferences. Billing, account deletion and token management are not on the list.
- A two-minute alarm polls Cloud notifications and shows approvals, due follow-ups, mentions, assignments and sync problems as desktop notifications when enabled.
- The side panel's Cloud tab holds the approval queue (edit, approve, reject; approval is blocked while placeholders remain), the Cloud Focus Queue and Ask Pigeon with source chips. Settings shows the Google connection, which is made on Google's consent screen; credentials stay in Cloud.
- In every mode, `content/placeholder-guard.ts` stops a message that still contains `[… NEEDED]` or `[CONFIRM …]` from sending unless the person confirms.

## Run mode and capabilities

`@pigeonbox/core` defines `PigeonBoxMode = 'local' | 'cloud'` and uses the capability list from `@pigeonbox/api-contract` (`local_ai`, `ask_inbox`, and Cloud capabilities such as `cloud_ai`, `cloud_tracking`, `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`, `cloud_calendar`, `cloud_semantic_search`, `cloud_relationships`, `cloud_documents`, `cloud_team`, `cloud_mcp`, `cloud_sequences`).

- **Local capabilities** are computed on the device from settings. They never depend on Cloud state, so a Cloud outage, an expired subscription, or signing out cannot change what Local does.
- **Cloud capabilities** come from `GET /v1/capabilities`, which the server derives from the account's entitlements. The client drops names it does not know.
- UI code asks `has('cloud_tracking')` (see `apps/extension/src/ui/product-state.ts`). It never branches on plan names.

The run mode is stored as `settings.runMode` and changes only through an explicit user action (`SET_RUN_MODE`). Choosing Cloud records `cloudConsentAt`; Cloud without recorded consent is invalid and migrates back to Local.

## Intelligence providers

The existing `AIProvider` interface in `packages/ai` is the intelligence interface:

```ts
interface AIProvider {
  classifyEmail(input); summarizeThread(input); draftReply(input); draftFollowUp(input);
  rewriteText(input); answerMailboxQuery(input); embed(texts);
}
```

`apps/extension/src/background/intelligence.ts` is the only place that picks an implementation:

| Setting | Provider |
|---|---|
| `runMode: 'cloud'` | `createCloudAIProvider(client)` from `@pigeonbox/cloud-client` |
| Local, downloaded model | `createPromptBackedProvider('local', …)` → offscreen WebGPU |
| Local, Gemini Nano | `createPromptBackedProvider('chrome', …)` |
| Local, Ollama / OpenAI / OpenAI-compatible | `createAIProvider(...)` |
| Local, ChatGPT web session | Experimental, source builds only |
| AI off | `null`; heuristics and rules still sort mail |

The agent, Ask Inbox, Write with AI and the Gmail UI only see an `AIProvider`. In Cloud mode the worker also presents an "effective" settings view to the agent (AI on, BYOK key blanked) without changing the saved Local configuration.

**Cloud never falls back.** If Cloud cannot serve a request, the provider throws a user-facing error ("PigeonBox Cloud is unavailable. Nothing was sent to another provider."). On-device heuristics and the extractive local summary keep working. The user can switch to Local explicitly.

Additional provider interfaces (search, sync, calendar, attachments) are deliberately not introduced yet: nothing implements them. Tracking is routed through one resolver (`trackerTarget()` in the worker) that returns either the self-hosted tracker and personal token or the Cloud tracker and Cloud access token.

## Cloud session

`background/cloud-session.ts`:

- Sign-in is Authorization Code + PKCE through `chrome.identity.launchWebAuthFlow`, with `chrome.identity.getRedirectURL('cloud')` as the redirect. The API brokers the identity provider (Supabase Auth); the extension holds no Supabase key and needs no Gmail permission to sign in.
- The refresh token is the only long-lived secret: `chrome.storage.local` (trusted contexts only). The access token lives in memory and `chrome.storage.session`.
- A session is bound to the API origin that issued it; tokens are never sent to another origin.
- Refreshes are single-flight. A rejected refresh token ends the session; a network failure keeps it.
- Signing out never changes the run mode or local data.

## Data

| Store | Name | Notes |
|---|---|---|
| IndexedDB | `gi_mailbox_v1` (Dexie, schema v4) | Name kept from before the rename so existing indexes survive. |
| `chrome.storage.local` | `settings`, `publicSettings`, `trackedEmails`, `onboardingComplete`, `chatgptSession`, `cloudSession` | Keys unchanged; `settings` carries `settingsVersion` and is migrated by `migrateSettings()`. |
| `chrome.storage.session` | `cloudAccess`, `cloudState`, `gmailRuntime`, `panelState`, diagnostics | Cleared when the browser closes. |
| OPFS | `model-files/` | Downloaded model weights (data, not code). |

## Packages

`apps/extension` is the only extension. There are no separate local and cloud builds; a release build differs from a source build only in build-time flags (`PIGEONBOX_RELEASE=1`: no source maps, experimental features off, no machine-local tracker config).

Packages not created, on purpose: a separate `local-ai` package (the WebGPU runtime is browser-specific and lives in `apps/extension/src/local-model`, with the model catalog in `packages/ai`) and a `ui` package (the extension is its only consumer).

## Tracking

See [tracking.md](tracking.md). The protocol-v3 classification logic exists in three places that must stay in step: `packages/tracking/src/lifecycle.ts` (client), `workers/tracker/src/helpers.ts` (Worker) and `convex/openRequest.ts` (Convex). The Worker's request handling is exported as `handleTrackerRequest(request, deps)` so PigeonBox Cloud reuses it unchanged with a tenant-scoped store.

## PigeonBox Cloud (private)

The private repository is a modular monolith on Cloudflare Workers (`api` and `tracker`) with Supabase (Auth, Postgres with RLS, later pgvector, Storage, Queues, Cron) and Stripe. It consumes the public packages it needs (`api-contract`, `shared`, `ai`, `tracking`, and the tracker handler) through a pinned, hash-checked vendor sync. See [cloud-protocol.md](cloud-protocol.md) for the interface.
