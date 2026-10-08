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
                Local          Cloud
                                  │
                          cloud-client
                                  │
                                  ▼
                         PigeonBox Cloud
```

**"PigeonBox Intelligence" is not a separate application.** "Intelligence" refers collectively to AI/search/agent-derived functionality inside PigeonBox. Likewise there is no "EmailApp" application; that was an old working name.

PigeonBox is **one Chrome extension with two execution environments** (Local and Cloud). There are exactly two codebases:

| Repository | Visibility | Owns |
|---|---|---|
| `pigeonbox` (this repo) | Public | The Chrome extension, Gmail integration, local mailbox, search and AI, BYOK, tracking client, and the typed client for PigeonBox Cloud. |
| `pigeonbox-cloud` | Private | Hosted infrastructure: hosted AI, accounts and auth, billing, Google mailbox sync, always-on agents, server-side intelligence, Cloud tracking and the account web app. |

> Rule: anything needed to interact with Gmail or run PigeonBox locally is public. Anything that exists because PigeonBox operates hosted production servers is private. The public repository never imports private code; it talks to Cloud over HTTPS using `@pigeonbox/api-contract`.

```
extension (public)
   │
   ├── @pigeonbox/core            run mode + capabilities
   ├── @pigeonbox/ai              AIProvider: on-device, Gemini Nano, Ollama, BYOK
   ├── @pigeonbox/cloud-client ──── HTTPS + @pigeonbox/api-contract ────▶ PigeonBox Cloud API (private)
   └── @pigeonbox/tracking     ──── tracker protocol v3 ─────────────────▶ self-hosted tracker, Convex, or Cloud tracker
```

### Dependency direction

Allowed: `extension → cloud-client → api-contract → (HTTPS) → Cloud server`.

Not allowed: the extension importing Cloud server source, Cloud importing extension code, `api-contract` depending on React or Supabase, and low-level domain packages (`gmail`, `mailbox`, `search`, `tracking`) talking to Cloud. Cloud access happens only from extension orchestration (`apps/extension/src/background`). `scripts/check-repo.mjs` enforces the public/private split.

## Workspace packages

| Package | Responsibility |
|---|---|
| `apps/extension` | The PigeonBox client: Manifest V3, service worker, Gmail content scripts, shared floating workspace, optional side panel, onboarding, settings, Chrome messaging and storage, and orchestration between the packages below. |
| `packages/core` | Product and runtime policy: Local vs Cloud mode, capability resolution and privacy boundaries. No UI. |
| `packages/shared` | Shared primitives: settings types and migration, extension message schemas, constants and small utilities. |
| `packages/gmail` | Gmail integration primitives: InboxSDK and DOM adapters, event and thread/message ID normalization, selectors, Gmail actions and draft placement. No AI reasoning. |
| `packages/mailbox` | Local mailbox persistence in IndexedDB: thread, message and search-document records and derived state. No React, no Cloud calls. |
| `packages/search` | Local retrieval: query parsing, lexical and hybrid search, and retrieval for Ask Pigeon, against mailbox records rather than Chrome UI. |
| `packages/ai` | AI providers and prompts: the `AIProvider` interface, on-device, Gemini Nano, Ollama and BYOK providers, and summary, draft and compact prompts. Does not decide Local vs Cloud. |
| `packages/agent` | Higher-level AI behavior: classify, summarize, draft, decide the next action and run permitted operations, using an `AIProvider` and the mailbox. |
| `packages/tracking` | Tracking domain logic: tracking IDs, pixel lifecycle, open classification and self-open filtering. |
| `packages/api-contract` | The public contract between `pigeonbox` and `pigeonbox-cloud`: Zod request/response schemas, route definitions, capabilities, the `ThreadIntel` DTO and the protocol version. |
| `packages/cloud-client` | The only public package that talks to PigeonBox Cloud: HTTP, auth headers, request/response validation, `PigeonBoxCloudClient` and the Cloud `AIProvider` adapter. |
| `workers/tracker` | The self-hostable open-tracking Worker (tracker protocol v3). |

## Extension layout

```
apps/extension/src/
├── background/              service worker (entry: index.ts)
│   ├── index.ts             message routing, agent loop, alarms, orchestration
│   ├── messaging.ts         who may send which message; storage hardening
│   ├── owner.ts             which addresses belong to the mailbox owner
│   ├── release-updates.ts   GitHub release check for source installs
│   ├── ai/                  provider-router.ts (picks the AIProvider), on-device.ts, chatgpt-login.ts
│   ├── cloud/               client.ts (Cloud client + state), session.ts (PKCE sign-in),
│   │                        thread-state.ts (Cloud thread state), page-calls.ts (allowlisted
│   │                        page → Cloud calls), notifications.ts (Cloud desktop notifications)
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
| Background service worker | `apps/extension/src/background/index.ts` | High | Owns settings, secrets, the Cloud session, the AI provider, the agent loop, tracking calls, IndexedDB. |
| Offscreen document | `apps/extension/src/offscreen/offscreen.ts` | High | Runs WebGPU models (transformers.js + ONNX Runtime Web) and Gemini Nano. |
| Extension pages | `workspace`, `settings`, `sidepanel`, `onboarding` | High | UI. Talk to the worker with messages. |

### Message trust

`background/messaging.ts` decides who may send what:

- Extension pages (origin `chrome-extension://<id>`) may send any message.
- Gmail content scripts may send only the Gmail-integration messages they need (ingest, summaries, drafts, tracking lifecycle). Settings writes, Cloud sign-in, run-mode changes, index clearing, Gmail actions and model downloads are refused.
- `chrome.storage.local` and `.session` are set to `TRUSTED_CONTEXTS`, so content scripts cannot read settings (BYOK key, tracker token) or the Cloud refresh token. The worker pushes public settings and tracked-email lists to Gmail tabs with messages instead.

### Cloud thread state in the extension

`background/cloud/` connects the extension to PigeonBox Cloud's always-on service (`thread-state.ts`, `page-calls.ts`, `notifications.ts`). This is an optional Cloud capability of the same extension, not a separate application. It is active only in Cloud mode, signed in, with `cloud_mail_sync`; Local mode never calls it.

- `CLOUD_THREAD_INTEL` (the only Cloud message a content script may send) returns read-only thread state: next action, deadline, promises, follow-up stage and the prepared draft with its sources and placeholders. Results are batched and cached for 20 seconds (`InflightCache`). The shared workspace renders its shell and local state immediately.
- `CLOUD_CALL` (extension pages only) calls an allowlisted contract route: approvals, Focus Queue, Ask Pigeon, connections and preferences. Billing, account deletion and token management are not on the list.
- A two-minute alarm polls Cloud notifications and shows approvals, due follow-ups, mentions, assignments and sync problems as desktop notifications when enabled.
- The shared workspace integrates prepared replies and follow-ups into Home, and current-conversation intelligence into the same surface. Approvals, activity, memory and other capability-gated features remain available through command search. Ask inherits the current thread. The optional side panel renders this same application. Settings shows Google connection and execution/privacy controls; credentials stay in Cloud.
- In every mode, `content/shell/placeholder-guard.ts` stops a message that still contains `[… NEEDED]` or `[CONFIRM …]` from sending unless the person confirms.

## Run mode and capabilities

`@pigeonbox/core` defines `PigeonBoxMode = 'local' | 'cloud'` and uses the capability list from `@pigeonbox/api-contract` (`local_ai`, `ask_inbox` (Ask Pigeon; the wire name is historical), and Cloud capabilities such as `cloud_ai`, `cloud_tracking`, `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`, `cloud_calendar`, `cloud_semantic_search`, `cloud_relationships`, `cloud_documents`, `cloud_team`, `cloud_mcp`, `cloud_sequences`).

- **Local capabilities** are computed on the device from settings. They never depend on Cloud state, so a Cloud outage, an expired subscription, or signing out cannot change what Local does.
- **Cloud capabilities** come from `GET /v1/capabilities`, which the server derives from the account's entitlements. The client drops names it does not know.
- UI code asks `has('cloud_tracking')` (see `apps/extension/src/ui/product-state.ts`). It never branches on plan names.

The run mode is stored as `settings.runMode` and changes only through an explicit user action (`SET_RUN_MODE`). Choosing Cloud records `cloudConsentAt`; Cloud without recorded consent is invalid and migrates back to Local.

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

The agent, Ask Pigeon, Write with AI and the Gmail UI only see an `AIProvider`. In Cloud mode the worker also presents an "effective" settings view to the agent (AI on, BYOK key blanked) without changing the saved Local configuration.

**Cloud never falls back.** If Cloud cannot serve a request, the provider throws a user-facing error ("PigeonBox Cloud is unavailable. Nothing was sent to another provider."). On-device heuristics and the extractive local summary keep working. The user can switch to Local explicitly.

Additional provider interfaces (search, sync, calendar, attachments) are deliberately not introduced yet: nothing implements them. Tracking is routed through one resolver (`trackerTarget()` in the worker) that returns either the self-hosted tracker and personal token or the Cloud tracker and Cloud access token.

## Cloud session

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

`apps/extension` is the only extension. The standard release ZIP includes Local and Cloud, with public production endpoints committed in `scripts/lib/release-config.mjs`. Fresh installations start in Local; Cloud still requires consent, sign-in and capabilities. Release hardening uses build-time flags (`PIGEONBOX_RELEASE=1`: no source maps, experimental features off, no machine-local tracker config).

Packages not created, on purpose: a separate `local-ai` package (the WebGPU runtime is browser-specific and lives in `apps/extension/src/local-model`, with the model catalog in `packages/ai`) and a `ui` package (the extension is its only consumer).

## Tracking

See [tracking.md](tracking.md). The protocol-v3 classification logic exists in three places that must stay in step: `packages/tracking/src/lifecycle.ts` (client), `workers/tracker/src/helpers.ts` (Worker) and `convex/openRequest.ts` (Convex). The Worker's request handling is exported as `handleTrackerRequest(request, deps)` so PigeonBox Cloud reuses it unchanged with a tenant-scoped store.

## PigeonBox Cloud (private)

Cloud mode extends the same extension; it never loads a separate application. `apps/web` in the Cloud repository is the account and control plane (sign-in, billing, connected Google accounts, privacy controls, approvals), not another mail client.

The private repository is a modular monolith on Cloudflare Workers (`api` and `tracker`) with Supabase (Auth, Postgres with RLS, later pgvector, Storage, Queues, Cron) and Stripe. It consumes the public packages it needs (`api-contract`, `shared`, `ai`, `tracking`, and the tracker handler) through a pinned, hash-checked vendor sync. See [cloud-protocol.md](cloud-protocol.md) for the interface.

## Legacy identifiers kept on purpose

These predate the PigeonBox name and are kept because renaming them would break installs, registrations or the Cloud protocol:

| Identifier | Where | Why it stays |
|---|---|---|
| `sdk_Intelligence_c698f940a0` | `INBOX_SDK_APP_ID` in `packages/shared` | Externally registered InboxSDK app ID. |
| `gi_mailbox_v1` | IndexedDB name, `packages/mailbox` | Existing installs keep their indexed mail under it. |
| `gi-*` CSS classes | extension UI and Gmail overlays | Internal prefix that avoids clashes with Gmail's CSS; no user impact. |
| `ask_inbox` | capability in `packages/api-contract` | Wire value Cloud grants; the feature is called Ask Pigeon. |
| `ASK_INBOX`, `CLOUD_THREAD_INTEL`, `CLOUD_INTEL_STATE`, `GET_THREAD_INTEL*`, `THREAD_INTELLIGENCE_UPDATED` | extension runtime messages | Message protocol names; `ThreadIntel` is the contract's thread-state DTO. |
| `threadsIntel`, `ThreadIntel*` schemas | `packages/api-contract` | Cloud API route and DTO names. |


## Ambient compose Brain

`shared/compose-context.ts` is a pure, synchronous routing detector. It preserves `classifyComposeClaim` for deterministic claims and adds checkable personal existence, status, uncertainty, prior-reference and relationship statements without requiring numbers or dates. Pure questions, opinions, current preferences, quoted history, URLs and boilerplate stay local. The server re-derives the hint.

The compose controller keeps the 900 ms idle delay, 2.8 s cooldown and five-minute in-memory cache keyed by clause, recipients, subject, thread and mailbox. Input handling only restarts the timer and increments a generation. The idle pass reads the body and chooses a fresh clause near the caret; per-key in-flight requests are deduplicated. Input and metadata changes invalidate old generations immediately. Quotes/signatures/reopened draft text remain excluded. No sending hooks change.

Cloud reuses `getRelevantContext`: structured checks first, then bounded exact context and optional existing semantic retrieval. Individual owner/person/topic facts retain provenance; weak/self-only matches do not warrant notices. The Cloud implementation bounds evidence to eight items and 1,400 conservative wire tokens, then permits one Luna judgment with reasoning none, Standard tier, 200 output tokens, no repair/fallback, and source revalidation. Opt-in, capability, request/AI rates and budgets remain enforced.

Semantic messages must copy complete selected evidence assertions or server-rendered event messages, preventing factual invention from passing on a valid citation alone. Suggestions replace one supported objective value. Underlines prioritize correction diffs, then a validated unique literal highlight (at most 160 characters), then the full clause. CSS Highlight ranges can span inline formatting; the editor DOM is unchanged. Sources remain restricted to Gmail and Google Calendar. Local mode remains independent.
