> Current UI and consistency model: [Unified workspace implementation](workspace-refactor.md).

# Architecture

```
                       PIGEONBOX
                           │
                Chrome Extension Client
                           │
       ┌───────────────────┼────────────────────┐
       │                   │                    │
      Gmail             Mailbox              Tracking
       │                   │
       │                Search
       │                   │
       └─────────────── AI / Agent
                           │
                  Provider Router
                   /             \
                Local          Server
                                  │
                          cloud-client
                                  │
                                  ▼
                   your PigeonBox server
```

**"PigeonBox Intelligence" is not a separate application.** "Intelligence" refers collectively to AI/search/agent-derived functionality inside PigeonBox. Likewise there is no "EmailApp" application; that was an old working name.

PigeonBox is **one Chrome extension with two execution environments**: **On this computer** (Local) and **your PigeonBox server** (server mode), a backend you deploy yourself on Cloudflare Workers and Supabase. Code calls server mode `cloud` (`runMode: 'cloud'`, `cloud_*` capabilities, `packages/cloud-client`). Everything, extension and server, lives in this repository:

| Part | Owns |
|---|---|
| Extension (`apps/extension` and the domain packages) | Gmail integration, local mailbox, search and AI, BYOK, the tracking client, and the typed client for the server. |
| Server (`packages/server`, `workers/api`, `workers/server-tracker`, `apps/web`, `supabase/migrations`) | Server-side AI, accounts and the access list, Google mailbox sync, always-on agents, per-account tracking and the dashboard. See [server/architecture.md](server/architecture.md). |
| Standalone tracker (`workers/tracker`, `convex/`) | A single-user open/click tracker for people who run no server. |

> Rule: the extension never imports server code; it talks to the server over HTTPS using `@pigeonbox/api-contract`. Local mode needs no server at all.

```
extension
   │
   ├── @pigeonbox/core            run mode + capabilities
   ├── @pigeonbox/ai              AIProvider: on-device, Gemini Nano, Ollama, BYOK
   ├── @pigeonbox/cloud-client ──── HTTPS + @pigeonbox/api-contract ────▶ your PigeonBox server (workers/api)
   └── @pigeonbox/tracking     ──── tracker protocol v3 ─────────────────▶ standalone tracker, Convex, or your server's tracker
```

### Dependency direction

Allowed: `extension → cloud-client → api-contract → (HTTPS) → server`. The server may import the shared packages (`api-contract`, `shared`, `ai`, `tracking`, `cloud-client`, the tracker handler).

Not allowed: anything in the extension importing `@pigeonbox/server`, `api-contract` depending on React or Supabase, and low-level domain packages (`gmail`, `mailbox`, `search`, `tracking`, `ai`, `agent`, `core`, `shared`) importing `@pigeonbox/cloud-client`. Server access happens only from extension orchestration (`apps/extension/src/background`). `scripts/check-repo.mjs` enforces these boundaries.

## Workspace packages

| Package | Responsibility |
|---|---|
| `apps/extension` | The PigeonBox client: Manifest V3, service worker, Gmail content scripts, shared floating workspace, optional side panel, onboarding, settings, Chrome messaging and storage, and orchestration between the packages below. |
| `packages/core` | Product and runtime policy: Local vs server mode, capability resolution and privacy boundaries. No UI. |
| `packages/shared` | Shared primitives: settings types and migration, extension message schemas, constants and small utilities. |
| `packages/gmail` | Gmail integration primitives: InboxSDK and DOM adapters, event and thread/message ID normalization, selectors, Gmail actions and draft placement. No AI reasoning. |
| `packages/mailbox` | Local mailbox persistence in IndexedDB: thread, message and search-document records and derived state. No React, no server calls. |
| `packages/search` | Local retrieval: query parsing, lexical and hybrid search, and retrieval for Ask Pigeon, against mailbox records rather than Chrome UI. |
| `packages/ai` | AI providers and prompts: the `AIProvider` interface, on-device, Gemini Nano, Ollama and BYOK providers, and summary, draft and compact prompts. Does not decide Local vs server. |
| `packages/agent` | Higher-level AI behavior: classify, summarize, draft, decide the next action and run permitted operations, using an `AIProvider` and the mailbox. |
| `packages/tracking` | Tracking domain logic: tracking IDs, pixel lifecycle, open classification and self-open filtering. |
| `packages/api-contract` | The contract between the extension and the server: Zod request/response schemas, route definitions, capabilities, the `ThreadIntel` DTO and the protocol version. |
| `packages/cloud-client` | The only extension package that talks to the server: HTTP, auth headers, request/response validation, `PigeonBoxCloudClient` and the server `AIProvider` adapter. |
| `workers/tracker` | The standalone single-user open-tracking Worker (tracker protocol v3). Its request handler is shared with the server tracker. |
| `packages/server` | Server logic: auth and the access list, AI pipeline, limits, the always-on Gmail layer, jobs. No UI. |
| `workers/api`, `workers/server-tracker` | The server's two Cloudflare Workers: the `/v1/*` API plus dashboard, and the per-account tracker. |
| `apps/web` | The server dashboard (static assets served by `workers/api`). |

## Extension layout

```
apps/extension/src/
├── background/              service worker (entry: index.ts)
│   ├── index.ts             message routing, agent loop, alarms, orchestration
│   ├── messaging.ts         who may send which message; storage hardening
│   ├── owner.ts             which addresses belong to the mailbox owner
│   ├── release-updates.ts   GitHub release check for source installs
│   ├── ai/                  provider-router.ts (picks the AIProvider), on-device.ts, chatgpt-login.ts
│   ├── cloud/               client.ts (server client + state), session.ts (PKCE sign-in),
│   │                        thread-state.ts (server thread state), page-calls.ts (allowlisted
│   │                        page → server calls), notifications.ts (server desktop notifications)
│   ├── search/              ask-pigeon.ts (answers Ask Pigeon from the local index)
│   └── tracking/            tracked-mail.ts, notifications.ts (open notifications)
├── content/                 Gmail content script (entry: index.ts → gmail.js)
│   ├── index.ts             InboxSDK/Gmail integration and wiring
│   ├── commands.ts          command palette
│   ├── thread/              ThreadPanel.tsx, CloudCompanion.tsx, chips.ts
│   ├── tracking/            compose tracking, tracking session, sent status, self-view detection
│   ├── compose/             per-compose add-ons: document action, real-time Pidgy checks (brain-checks.ts, brain-notice.ts)
│   └── shell/               shadow-DOM surface, floating drag, toasts, placeholder send guard
├── local-model/             WebGPU / Gemini Nano runtime (offscreen)
├── main-world/  offscreen/  onboarding/  workspace/  settings/  setup/  sidepanel/  ui/  preview/
```

## Runtime contexts

| Context | File | Trust | Does |
|---|---|---|---|
| Content script (isolated world on `mail.google.com`) | `apps/extension/src/content/index.ts` | Low: runs in Gmail's renderer | Reads Gmail through `packages/gmail`, owns the floating presentation host and chips, and sends allowlisted messages to the worker. The application renders in a trusted extension iframe. The content script never sees keys, tokens or full settings. |
| MAIN world | `apps/extension/src/main-world/index.ts` | None | Intentionally empty. InboxSDK injects its own `pageWorld.js`. |
| Background service worker | `apps/extension/src/background/index.ts` | High | Owns settings, secrets, the server session, the AI provider, the agent loop, tracking calls, IndexedDB. |
| Offscreen document | `apps/extension/src/offscreen/offscreen.ts` | High | Runs WebGPU models (transformers.js + ONNX Runtime Web) and Gemini Nano. |
| Extension pages | `workspace`, `settings`, `sidepanel`, `onboarding` | High | UI. Talk to the worker with messages. |

### Message trust

`background/messaging.ts` decides who may send what:

- Extension pages (origin `chrome-extension://<id>`) may send any message.
- Gmail content scripts may send only the Gmail-integration messages they need (ingest, summaries, drafts, tracking lifecycle). Settings writes, server sign-in, run-mode changes, index clearing, Gmail actions and model downloads are refused.
- `chrome.storage.local` and `.session` are set to `TRUSTED_CONTEXTS`, so content scripts cannot read settings (BYOK key, tracker token) or the server refresh token. The worker pushes public settings and tracked-email lists to Gmail tabs with messages instead.

### Server thread state in the extension

`background/cloud/` connects the extension to your PigeonBox server's always-on layer (`thread-state.ts`, `page-calls.ts`, `notifications.ts`). This is an optional capability of the same extension, not a separate application. It is active only in server mode, signed in, with `cloud_mail_sync`; Local mode never calls it.

- `CLOUD_THREAD_INTEL` (the only server message a content script may send) returns read-only thread state: next action, deadline, promises, follow-up stage and the prepared draft with its sources and placeholders. Results are batched and cached for 20 seconds (`InflightCache`). The shared workspace renders its shell and local state immediately.
- `CLOUD_CALL` (extension pages only) calls an allowlisted contract route: approvals, Focus Queue, Ask Pigeon, connections and preferences. Account deletion, tokens and webhooks are not on the list.
- A two-minute alarm polls server notifications and shows approvals, due follow-ups, mentions, assignments and sync problems as desktop notifications when enabled.
- The shared workspace integrates prepared replies and follow-ups into Home, and current-conversation intelligence into the same surface. Approvals, activity, memory and other capability-gated features remain available through command search. Ask inherits the current thread. The optional side panel renders this same application. Settings shows Google connection and execution/privacy controls; Google credentials stay on the server.
- In every mode, `content/shell/placeholder-guard.ts` stops a message that still contains `[… NEEDED]` or `[CONFIRM …]` from sending unless the person confirms.

## Run mode and capabilities

`@pigeonbox/core` defines `PigeonBoxMode = 'local' | 'cloud'` and uses the capability list from `@pigeonbox/api-contract` (`local_ai`, `ask_inbox` (Ask Pigeon; the wire name is historical), and server capabilities such as `cloud_ai`, `cloud_tracking`, `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`, `cloud_calendar`, `cloud_semantic_search`, `cloud_relationships`, `cloud_documents`, `cloud_team`, `cloud_mcp`, `cloud_sequences`).

- **Local capabilities** are computed on the device from settings. They never depend on server state, so a server outage or signing out cannot change what Local does.
- **Server capabilities** come from `GET /v1/capabilities`. Every account on the server's `ALLOWED_EMAILS` list gets every capability the server is configured to serve (`servedCapabilities` in `packages/server/src/config.ts`). The client drops names it does not know.
- UI code asks `has('cloud_tracking')` (see `apps/extension/src/ui/product-state.ts`) instead of guessing from the mode or the server's setup.

The run mode is stored as `settings.runMode` and changes only through an explicit user action (`SET_RUN_MODE`). Choosing server mode records `cloudConsentAt`; server mode without recorded consent is invalid and migrates back to Local.

## AI providers

The `AIProvider` interface in `packages/ai` is the one AI interface:

```ts
interface AIProvider {
  classifyEmail(input); summarizeThread(input); draftReply(input); draftFollowUp(input);
  rewriteText(input); answerMailboxQuery(input); embed(texts);
}
```

`apps/extension/src/background/ai/provider-router.ts` (`resolveAIProvider`) is the only place that picks an implementation:

| Setting | Provider |
|---|---|
| `runMode: 'cloud'` | `createCloudAIProvider(client)` from `@pigeonbox/cloud-client` |
| Local, downloaded model | `createPromptBackedProvider('local', …)` → offscreen WebGPU |
| Local, Gemini Nano | `createPromptBackedProvider('chrome', …)` |
| Local, Ollama / OpenAI / OpenAI-compatible | `createAIProvider(...)` |
| Local, ChatGPT web session | Experimental, source builds only |
| AI off | `null`; heuristics and rules still sort mail |

The agent, Ask Pigeon, Write with AI and the Gmail UI only see an `AIProvider`. In server mode the worker also presents an "effective" settings view to the agent (AI on, BYOK key blanked) without changing the saved Local configuration.

**Server mode never falls back.** If the server cannot serve a request, the provider throws a user-facing error ("Your PigeonBox server is unavailable. Nothing was sent to another provider."). On-device heuristics and the extractive local summary keep working. The user can switch to Local explicitly.

Additional provider interfaces (search, sync, calendar, attachments) are deliberately not introduced yet: nothing implements them. Tracking is routed through one resolver (`trackerTarget()` in the worker) that returns either the standalone tracker and personal token or your server's tracker and the server access token.

## Server session

`background/cloud/session.ts`:

- Sign-in is Authorization Code + PKCE through `chrome.identity.launchWebAuthFlow`, with `chrome.identity.getRedirectURL('cloud')` as the redirect. The API brokers the identity provider (Supabase Auth); the extension holds no Supabase key and needs no Gmail permission to sign in.
- The refresh token is the only long-lived secret: `chrome.storage.local` (trusted contexts only). The access token lives in memory and `chrome.storage.session`.
- A session is bound to the API origin that issued it; tokens are never sent to another origin.
- Refreshes are single-flight. A rejected refresh token ends the session; a network failure keeps it.
- Signing out never changes the run mode or local data.

## Data

| Store | Name | Notes |
|---|---|---|
| IndexedDB | `gi_mailbox_v1` (Dexie, schema v4) | Legacy name ("Gmail Intelligence") kept on purpose so existing indexes survive; renaming needs a data migration. |
| `chrome.storage.local` | `settings`, `publicSettings`, `trackedEmails`, `onboardingComplete`, `chatgptSession`, `cloudSession` | Keys unchanged; `settings` carries `settingsVersion` and is migrated by `migrateSettings()`. |
| `chrome.storage.session` | `cloudAccess`, `cloudState`, `gmailRuntime`, `panelState`, diagnostics | Cleared when the browser closes. |
| OPFS | `model-files/` | Downloaded model weights (data, not code). |

## Builds

`apps/extension` is the only extension. The GitHub release ZIP carries no server endpoints and runs on this computer. A build for your server is made from source: `npm run server:deploy` writes the server URLs into `apps/extension/.env.local` (`VITE_PIGEONBOX_CLOUD_API_URL`, `VITE_PIGEONBOX_CLOUD_TRACKER_URL`) and rebuilds `apps/extension/dist`; **Settings → Advanced → PigeonBox server URL** can override the API URL (see [cloud-protocol.md](cloud-protocol.md#configuring-the-extension)). Fresh installations start in Local; server mode still requires consent, sign-in and capabilities. Release hardening uses build-time flags (`PIGEONBOX_RELEASE=1`: no source maps, experimental features off, no machine-local tracker config).

Packages not created, on purpose: a separate `local-ai` package (the WebGPU runtime is browser-specific and lives in `apps/extension/src/local-model`, with the model catalog in `packages/ai`) and a `ui` package (the extension is its only consumer).

## Tracking

See [tracking.md](tracking.md). The protocol-v3 classification logic exists in three places that must stay in step: `packages/tracking/src/lifecycle.ts` (client), `workers/tracker/src/helpers.ts` (Worker) and `convex/openRequest.ts` (Convex). The Worker's request handling is exported as `handleTrackerRequest(request, deps)` so the server tracker (`packages/server/src/tracker.ts`) reuses it unchanged with a per-account store.

## Your PigeonBox server

Server mode extends the same extension; it never loads a separate application. `apps/web` is the dashboard (sign-in, connected Google accounts, privacy controls, approvals), not another mail client.

The server is a modular monolith on Cloudflare Workers (`workers/api` and `workers/server-tracker`, both over `packages/server`) with Supabase (Auth, Postgres with RLS, pgvector, Storage, Queues, Cron). It imports the shared packages it needs (`api-contract`, `shared`, `ai`, `tracking`, and the tracker handler) directly from this repository. Who may use it is set by its `ALLOWED_EMAILS` access list. See [server/architecture.md](server/architecture.md) for its internals, [cloud-protocol.md](cloud-protocol.md) for the interface, and [self-hosting.md](self-hosting.md) to deploy one.

## Legacy identifiers kept on purpose

These predate the PigeonBox name and are kept because renaming them would break installs, registrations or the server protocol:

| Identifier | Where | Why it stays |
|---|---|---|
| `sdk_Intelligence_c698f940a0` | `INBOX_SDK_APP_ID` in `packages/shared` | Externally registered InboxSDK app ID. |
| `gi_mailbox_v1` | IndexedDB name, `packages/mailbox` | Existing installs keep their indexed mail under it. |
| `gi-*` CSS classes | extension UI and Gmail overlays | Internal prefix that avoids clashes with Gmail's CSS; no user impact. |
| `ask_inbox` | capability in `packages/api-contract` | Wire value the server grants; the feature is called Ask Pigeon. |
| `ASK_INBOX`, `CLOUD_THREAD_INTEL`, `CLOUD_INTEL_STATE`, `GET_THREAD_INTEL*`, `THREAD_INTELLIGENCE_UPDATED` | extension runtime messages | Message protocol names; `ThreadIntel` is the contract's thread-state DTO. |
| `threadsIntel`, `ThreadIntel*` schemas | `packages/api-contract` | Server API route and DTO names. |


## Ambient compose Brain

`shared/compose-context.ts` is a pure, synchronous routing detector. It preserves `classifyComposeClaim` for deterministic claims and adds checkable personal existence, status, uncertainty, prior-reference and relationship statements without requiring numbers or dates. Pure questions, opinions, current preferences, quoted history, URLs and boilerplate stay local. The server re-derives the hint.

The compose controller keeps the 900 ms idle delay, 2.8 s cooldown and five-minute in-memory cache keyed by clause, recipients, subject, thread and mailbox. Input handling only restarts the timer and increments a generation. The idle pass reads the body and chooses a fresh clause near the caret; per-key in-flight requests are deduplicated. Input and metadata changes invalidate old generations immediately. Quotes/signatures/reopened draft text remain excluded. No sending hooks change.

The server reuses `getRelevantContext`: structured checks first, then bounded exact context and optional existing semantic retrieval. Individual owner/person/topic facts retain provenance; weak/self-only matches do not warrant notices. The server implementation bounds evidence to eight items and 1,400 conservative wire tokens, then permits one model judgment with reasoning none, Standard tier, 200 output tokens, no repair/fallback, and source revalidation. Opt-in, capability, request/AI rates and budgets remain enforced.

Semantic messages must copy complete selected evidence assertions or server-rendered event messages, preventing factual invention from passing on a valid citation alone. Suggestions replace one supported objective value. Underlines prioritize correction diffs, then a validated unique literal highlight (at most 160 characters), then the full clause. CSS Highlight ranges can span inline formatting; the editor DOM is unchanged. Sources remain restricted to Gmail and Google Calendar. Local mode remains independent.
