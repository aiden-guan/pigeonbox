# Changelog

All notable changes to PigeonBox (formerly Gmail Intelligence) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.5.2] — 2026-10-04

### Added
- **Ask Pigeon writes emails for you.** Ask it to email someone and it finds their address in your contacts or mail, then opens the email in Gmail's composer, addressed and ready to review. It is never sent automatically.
- **Voice input in Ask.** Tap the mic to dictate. Chrome turns speech into text; the first use opens a tab to allow the microphone.
- **Suggested follow-ups** after each answer, one tap to ask.
- **Thumbs up or down on answers**, with an optional note on what went wrong.

### Changed
- **The Ask box wraps and grows** as you type. Enter asks; Shift+Enter adds a line.
- **Faster Cloud answers.** People named in a question and their latest mail are looked up before Pigeon starts thinking, so many questions are answered in one step.

---

## [0.5.1] — 2026-10-04

### Changed
- **Ask Pigeon (Cloud) is a conversation.** Answers stream in as they are written, show what Pigeon is searching, and follow-up questions keep the earlier turns.
- **Ask answers are easier to read.** Body-size text instead of a large serif, the direct answer first, details as short labelled bullets, and small group labels.
- Cloud entitlements report the share of the monthly Cloud AI allowance used (`aiMonthlyUsed`), for a usage bar without token counts.
- **Narrower permissions.** Settings asks Chrome for tracker and AI host access only when that feature is on and Cloud mode is off.
- **Compose tracking badge** sits in its own bar below Send without covering Gmail's tools, shows the thinking orb while preparing, and no longer stays on Preparing. Sent-status marks have their own slot.
- **Drafts** may not claim you reviewed, sent or completed something unless your own text says so. Replies that open with "Here's my reply" or a subject line are cleaned or rejected.
- **Packaging** builds in an isolated staging directory and never replaces `apps/extension/dist`, the folder Chrome loads. `--skip-build` now requires `--from <dir>`.
- Cloud dashboard links open on usepigeonbox.com.
- Workspace navigation is aligned and matches the dashboard's dark palette. Pidgy sprite assets and Orb motion are refreshed.
- **Settings is one click away.** The Gmail workspace has a Settings gear next to appearance and dock, in floating and docked layouts. Settings navigation now matches the page, never links to a hidden section, and explains what stays on this computer and what goes to an AI provider, Cloud or your tracker. Configured Cloud builds add one **Manage Cloud account ↗** action.
- **Tracking wording.** Sent marks, the detail card and alerts report detections ("Open detected", "Link clicked") and never name a reader, since one pixel is shared by every recipient. Alerts are grouped per email and open the Gmail conversation when clicked.
- **Tracking detail card** lists Sent and each counted open and click, and says when an email went to several people.

### Fixed
- Tracker recipients and subject follow compose edits made after the tracker is created, so they are right even if Gmail never fires sent.
- A thread summary no longer drops out when its job finishes before it is looked up.
- Click tracking: a link is rewritten only after the tracker confirms its click ID, so a failed update can no longer send recipients to an error page. Destinations with `&amp;` in the HTML now redirect to the decoded URL.
- Tracked-email updates, self-view claims and activity go only to the tracker that issued the ID, after a switch between Local and Cloud.
- PigeonBox Cloud tracking refreshes an expired access token and retries once.
- Tracker: counters are recomputed from the full event history instead of the newest 200 events; one claims query per pixel; bounded request bodies; schema errors return 400; store errors no longer echo database messages; a sent email cannot be marked cancelled; a send time ahead of the tracker clock is clamped; unknown links show a plain page instead of JSON. Links whose path only resembles a tracker route (such as `youtube.com/c/…`) are tracked.

---

## [0.5.0] — 2026-10-02

### Changed
- Local packages ship with explicitly empty Cloud endpoints. Configured development and beta builds remain available separately.
- Onboarding, Settings and unavailable Cloud actions open the Cloud waitlist without changing mode or starting authentication.
- Privacy disclosures cover Cloud intelligence and the optional waitlist. Documentation is indexed and historical reports are archived.

---

## [0.4.0] — 2026-10-02

### Added
- **Dispatch redesign.** Popup, side panel, settings, onboarding and the Gmail companion share one ink/paper system with small-radius geometry. Command rows replace the action tiles, the launcher expands in place into the command surface, and inbox categories show real counts. Selecting a mail row opens it as a brief that keeps its sender and subject. Motion follows real state: the index count rolls when it grows, and Pidgy acknowledges once. Reduced motion is respected. See [docs/dispatch-redesign.md](docs/archive/dispatch-redesign.md).
- **Memory settings** for PigeonBox Cloud: search, inspect, correct, forget and purge what Cloud has learned, with independent learning and Fast Recall switches.
- Ask chat helpers and memory contracts shared with PigeonBox Cloud.

### Changed
- **Architecture and naming cleanup, no behavior change.** The extension's service worker is organized by responsibility (`background/ai`, `background/cloud`, `background/search`, `background/tracking`) and the Gmail content script by concern (`content/thread`, `content/tracking`, `content/shell`). `background/intelligence.ts` is now `background/ai/provider-router.ts` (`resolveAIProvider`), Cloud thread state lives in `background/cloud/thread-state.ts`, and Ask Inbox is called Ask Pigeon throughout. See [docs/architecture.md](docs/architecture.md).
- The local Supabase `project_id` is `pigeonbox` (was the old working name `EmailApp`). It only names local Docker containers and volumes; stop a stack started under the old ID with `supabase stop --project-id EmailApp`.
- `npm run check:repo` also checks package boundaries: low-level packages never import `@pigeonbox/cloud-client`, and `@pigeonbox/api-contract` never imports React or Supabase.

---

## [0.3.1] — 2026-09-26

### Added
- **Chrome Web Store readiness**: a public [privacy policy](PRIVACY.md), listing text and dashboard answers ([docs/store/listing.md](docs/store/listing.md)), and store screenshots and promo tiles generated from real UI (`apps/extension/scripts/make-store-assets.py`).
- **Release automation for the store**: tagging a release uploads the same ZIP to the Chrome Web Store and submits it for review, once the store credentials are configured (`scripts/publish-chrome-web-store.mjs`).
- Release builds include PigeonBox Cloud when the repository variables `PIGEONBOX_CLOUD_API_URL` and `PIGEONBOX_CLOUD_TRACKER_URL` are set.

### Changed
- Copies installed from the Chrome Web Store, which Chrome updates itself, no longer check GitHub for updates or show the popup's Reload button.

## [0.3.0] — 2026-09-26

### Added
- **Ask Inbox understands the question before searching**: it reads direction (sent or received), time windows ("yesterday", "last week", "past 3 days"), counts ("last 5 emails") and intent. It answers list questions, "what needs a reply" and "who hasn't replied" straight from the local index, with no model call.
- **Draft an email from Ask Inbox**: "draft an email to Sam saying I'll be late" finds Sam's address in your mail, writes the draft with your recent threads as context and opens it in a Gmail compose window. PigeonBox never sends it.
- **Waiting view** in the side panel: mail you sent that has had no reply, with open status and a timeline of every open and click that counts.
- **`npm run dev:reload:install`** (macOS): keeps the dev reload helper running in the background as a LaunchAgent.

### Fixed
- **"What do I need to reply to?" no longer lists threads you already answered.** Each candidate is re-checked when you ask, and only threads where someone else clearly wrote last are shown. Your own sent threads, calendar invitations, no-reply and notification senders, and mailing-list mail that doesn't name you are left out.
- **Classification uses the newest message's sender, not the Gmail folder.** A thread opened from the Inbox where you replied last is no longer tagged "Respond".
- **PigeonBox recognizes you across accounts and aliases.** It remembers every Gmail account it has seen you signed in with, and also recognizes Gmail's "me" label and your full name, so replies from a school or work address count as yours.
- Lexical search ignores filler words and short prefixes that used to match nearly every thread.

### Changed
- The Ask Inbox model now sees a status line on each thread saying who wrote last. On-device models also get today's date and who "you" are.
- Ask Inbox loads the search index once per question instead of twice.

## [0.2.0] — 2026-09-26

### Summary
PigeonBox becomes one unified extension with two execution environments: **Local** (on this computer, 100% anonymous, no account required) and **PigeonBox Cloud** (hosted, subscription). Local remains a complete product with zero silent fallbacks, reinforced security boundaries, and automated monorepo release verification.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **Dual Execution Engine** (`@pigeonbox/core`) | Introduced unified extension architecture with explicit `local` vs `cloud` run mode selector | Enables 100% anonymous, on-device local execution while supporting hosted cloud convenience without code forks. |
| **Typed Cloud Protocol** (`@pigeonbox/api-contract`, `@pigeonbox/cloud-client`) | Defined Zod-validated protocol contracts with compile-time `AIProvider` drift guards | Guarantees zero runtime schema mismatches between client extension and remote inference gateway. |
| **Zero-Leak Storage Isolation** (`apps/extension`) | Restricted `chrome.storage` to `TRUSTED_CONTEXTS` and established `senderMaySend` allowlist | Quarantines all BYOK keys, tokens, and credentials in the service worker; untrusted Gmail DOM never sees secrets. |
| **Deterministic Release Verification** (`scripts/verify.mjs`, `scripts/package-extension.mjs`) | Added single-command `npm run verify` CI pipeline and SHA-256 checksummed packaging | Eliminates release regressions, secret leakage, and missing dependencies across all 11 monorepo packages. |
| **Floating Thread Card** (`apps/extension/src/content`) | Added draggable and resizable floating companion card inside Gmail threads | Provides frictionless ergonomics allowing users to reposition summaries and action items anywhere in the viewport. |
| **Real Mascot Icons** (`apps/extension/scripts/make-icons.py`) | Generated crisp 16x16, 48x48, and 128x128 icons from the idle pigeon sprite sheet | Fulfills Chrome Web Store store listing asset requirements with brand-consistent pixel art. |

### Detailed Changes

#### Added
- **Extension updates**: Added opt-in GitHub release checks for Local and Cloud mode (Settings → Updates), with a one-click download for the latest stable release ZIP. Checks are off by default and use an optional `api.github.com` permission.
- **`@pigeonbox/api-contract`**: Added typed PigeonBox Cloud protocol (Zod schemas, route table, error codes, protocol versioning, capabilities), with a compile-time guard against drift from the local `AIProvider` types.
- **`@pigeonbox/cloud-client`**: Added Cloud HTTP client, PKCE helpers, and a Cloud-backed `AIProvider`.
- **`@pigeonbox/core`**: Added run mode (`local` | `cloud`) and a capability layer; UI checks capabilities instead of modes or plans.
- **`apps/extension`**: Added Settings and onboarding for **How should PigeonBox run?** (On this computer / PigeonBox Cloud / Advanced), explicit Cloud consent, Cloud account status, billing links, and "Run on this computer instead".
- **`apps/extension`**: Added Cloud sign-in with Authorization Code + PKCE via `chrome.identity`; tokens bound to the issuing API origin; single-flight refresh.
- **`apps/extension`**: Added Cloud tracking: the background worker routes tracker calls to the hosted tracker with the Cloud token in Cloud mode.
- **`apps/extension`**: Implemented drag and resize interactions for the floating thread companion card.
- **`apps/extension`**: Enabled drafting replies matching the mailbox owner's tone and signature with a saved owner profile.
- **`scripts`**: Added `npm run verify`, `npm run package` (deterministic ZIP + SHA-256), repository checks (`check-repo.mjs`: namespace, private imports, secrets, env files), and version checks (`check-versions.mjs`).
- **`CI/CD`**: Added GitHub Actions CI (`.github/workflows/ci.yml`) and tag-driven release workflows (`.github/workflows/release.yml`); added Dependabot, issue templates, and PR template.
- **`docs`**: Added architecture, local setup, self-hosting, Convex self-hosting, Cloud protocol, privacy model, threat model, tracking, Chrome Web Store readiness, and release process guides.

#### Changed / Refactored
- **Monorepo**: Renamed all packages from the legacy `gi` scope to `@pigeonbox/*`; root package unified to `pigeonbox`. All versions unified at 0.2.0.
- **Branding**: Extension name unified as **PigeonBox**; InboxSDK app name updated to PigeonBox.
- **Settings**: Settings are versioned (`settingsVersion: 2`) and migrated on load. Every stored field is preserved; existing installs migrate safely to Local mode.
- **Permissions**: Required host permissions reduced strictly to `https://mail.google.com/*`. Removed `tabs` and `activeTab`. Tracker hosts (`localhost:8787`, `*.convex.site`), `chatgpt.com`, and `identity` are optional and requested only when enabled.
- **ChatGPT Session**: ChatGPT web sign-in moved to Advanced → Experimental and excluded from release builds.
- **Tracker Handler**: The tracker Worker request handling is exported as `handleTrackerRequest(request, deps)` for reuse across memory and cloud stores.

#### Security
- **Context Isolation**: Content scripts no longer receive full settings. Storage (`chrome.storage.local`/`.session`) is restricted to trusted contexts; public settings and tracked emails are pushed to Gmail tabs via typed messages.
- **Message Gateway**: Privileged runtime messages (settings mutation, sign-in, run mode changes, index clearing, Gmail actions, model downloads) are strictly refused from content scripts.
- **Settings Race Condition**: Fixed an issue where reopening Settings and saving could overwrite the stored API key and tracker token with blanks.
- **Tracker Timing Attacks**: Tracker Worker and Convex compare personal API tokens in constant time.
- **Release Hygiene**: Release builds exclude source maps and machine-local `tracker-config.json`; packaging rejects archives containing credentials.

#### Fixed
- **Extension Icons**: Replaced 16×16 placeholder icons with crisp, pixel-perfect 16×16, 48×48, and 128×128 icons generated from the idle pigeon in the sprite sheet (`apps/extension/scripts/make-icons.py`).
- **Settings State**: The "AI Inbox" toggle in Settings now properly reflects Cloud mode state.

#### Documentation & Presentation
- **Showcase Overhaul**: Redesigned root `README.md` with complete architecture Mermaid diagram, 2x2 visual feature grid, 4 engineering deep dives (PAWT framework), and full verification guide.
- **Asset Library**: Curated retina product screenshots into `assets/readme/` for high-impact visual representation.

### Verification Proof
- `npm run verify`: Passed all verification steps (dependencies, versions, hygiene checks, typecheck, lint, 35 test files / 348 tests, production build, and deterministic release packaging).

---

## [0.1.1] — 2026-09-24

### Summary
Implemented a durable sender self-open suppression architecture based on exact message identity, separated message render milestones, and one-shot server-side self-view claims, completely replacing fixed timestamp-window correlation.

### Architectural & Functional Highlights
| Component / Layer | Change | Impact |
| :--- | :--- | :--- |
| **One-Shot Self-View Claims** (`workers/tracker`, `convex`, `supabase`) | Added short-lived (25s) exact-message self-view claims consumed atomically by sender pixels | Prevents delayed Gmail image loads (>8s) from triggering false recipient opens, while immediately allowing subsequent recipient opens. |
| **Separated Render Milestones** (`apps/extension`) | Separated `expandedAt` and `loadedAt` into independent state milestones in `ActiveMessageViewState` | `MESSAGE_LOAD` uses its actual load timestamp and strengthens the claim without reusing stale `expandedAt`. |
| **Priority Deduplication** (`apps/extension`) | Allowed stronger signals (`MESSAGE_LOAD`) to upgrade claims even after `MESSAGE_EXPANDED` or `CACHE_REINSPECTION` | Ensures sender claims stay active during slow Gmail proxy renders without dropping render milestones. |
| **Delivery Retries & Idempotency** (`apps/extension`, `packages/tracking`) | Added exponential retry (3 attempts) with deterministic `selfViewEventId` idempotency key | Prevents transient delivery failures from disabling sender suppression; backend safely upserts single logical claim. |
| **Tracker Protocol v3 & Health Diagnostics** (`packages/tracking`, `workers/tracker`, `convex`, `apps/extension`) | Introduced protocol version 3 and feature negotiation (`self_view_claims`) | Settings & diagnostics detect and warn on outdated tracker deployments instead of falsely reporting healthy. |
| **Supabase & Convex Parity** (`supabase/migrations`, `convex`) | Added `tracking_self_view_claims` table, indexes, and updated classification check constraint | Added full support for `PROXY_LIKELY` and `MACHINE_LIKELY` alongside claims in Supabase and Convex. |
| **InboxSDK Single Registration** (`packages/gmail`, `apps/extension`) | Made `InboxSdkAdapter` single owner of SDK view handlers with raw-view hooks, removing duplicate registrations in `mountSdkUi` | Eliminates duplicate handler firings and ensures handlers register strictly once per Gmail page lifecycle. |
| **NavMenu Error Fix** (`apps/extension`) | Removed `sdk.NavMenu.addNavItem` calls from `mountSdkUi` | Eliminates InboxSDK 2.2.26 `Error("should not happen")` crashes when Gmail's nav container is unmounted on `#inbox`. |

### Detailed Changes

#### Added
- **`packages/gmail/src/InboxSdkAdapter.ts`**: Added `InboxSdkHooks` (`onThreadView`, `onMessageView`, `onComposeView`, `onThreadRowView`), `InboxSdkAdapterOptions`, and exported view type definitions (`ThreadViewLike`, `MessageViewLike`, `ComposeViewLike`, `ThreadRowViewLike`).
- **`packages/gmail/src/index.ts`**: Added `hooks` option to `CompositeGmailOptions`, added `setHooks` and `getHooks` to `CompositeGmailAdapter`.
- **`apps/extension/src/content/inboxsdk-integration.test.ts`**: Added regression test suite verifying `mountSdkUi()` never registers handlers or NavMenu items on SDK directly, routes all UI and tracking features via hooks, and handles restart/reload cleanly.
- **`packages/gmail/src/lifecycle.test.ts`**: Added regression tests verifying strictly-once InboxSDK handler registration across repeated starts, stops, restarts, and multiple adapter bindings.
- **`supabase/migrations`**: Created `20260924000000_self_view_claims.sql` adding `tracking_self_view_claims` table and expanding `tracking_events` check constraint to include `PROXY_LIKELY` and `MACHINE_LIKELY`.
- **`convex/schema.ts` & `convex/tracking.ts`**: Added `selfViewClaims` table schema, indexes, atomic claim consumption, render-burst grace window, and retroactive reclassification.
- **`convex/tracking.test.ts`**: Added comprehensive mutation test suite for Convex tracking claims and race conditions.
- **`workers/tracker`**: Added `ClaimRow` and claims methods to `TrackerStore`, implemented in `MemoryTrackerStore` and `SupabaseTrackerStore`.
- **`packages/tracking`**: Added `SelfViewClaim` interface, `SelfViewAck`, protocol versioning constants (`TRACKER_PROTOCOL_VERSION = 3`), and feature requirements.
- **`packages/shared`**: Updated `RuntimeMessageSchema` to include `source`, `selfViewEventId`, and `retryCount` for `TRACKING_SELF_VIEW`.
- **`apps/extension/src/local-model/qwen-model.ts`**: Added WebGPU device support, active generator caching across prompts, and validation check during model download.
- **`apps/extension/src/content/thread-panel.tsx`**: Added structured section headings ("Summary", "Dates", "Key details", "To do"), actionable retry state on summary failure, and drafting state indicator.
- **`packages/tracking`**, **`workers/tracker`**, **`convex`**: Added native mobile email client UA detection (`Gmail`, `Outlook-iOS/Android`, `AppleMail`, `iPhone Mail`, `Samsung Email`, `Yahoo Mail`).

#### Changed / Refactored
- **`apps/extension/src/content/index.ts`**: Added DOM message body fallback when adapter thread is empty; added polling with 5-minute timeout for background AI jobs; deduplicated in-flight draft requests per thread; and cleaned up disconnected sidebar elements.
- **`packages/ai/src/summary-prompt.ts` & `packages/shared/src/local-summary.ts`**: Streamlined compact summary prompt for small on-device models; stripped superseded announcements and conflicting week numbers from summary input.
- **`packages/agent/src/index.ts`**: Bumped summary fingerprint version to `sum7`; extended local model timeout to 300s in AIJobQueue; provided local fallback summary on model error.
- **`apps/extension/src/setup/AiConnect.tsx`**: Disabled model download button during download; wired "Use this model" button directly to model downloader if not yet cached.
- **`apps/extension/src/content/index.ts`**: Refactored `mountSdkUi()` to configure `InboxSdkHooks` on the adapter rather than registering handlers on `sdk` directly; removed `sdk.NavMenu.addNavItem()` block; guarded `chrome.` runtime calls and automatic `boot()`.
- **`packages/gmail/src/InboxSdkAdapter.ts`**: Bound SDK handlers once per SDK instance using a Symbol state record and WeakMap; dispatched events to the active adapter and invoked raw-view hooks safely.
- **`apps/extension/message-self-view.ts`**: Captured distinct `loadedAt` on MessageView `load` events, completely removing `expandedAt` reuse.
- **`apps/extension/self-view-dedupe.ts`**: Upgraded priority rules so `MESSAGE_LOAD` is never deduped against weaker signals.
- **`apps/extension/background`**: Replaced silent catch with bounded retry loop using `selfViewEventId`; reported diagnostic health status to session storage.
- **`apps/extension/src/settings/SettingsApp.tsx`**: Surfaced Tracker base URL and Personal API token directly in the Email Tracking section with live connection probing on blur, cleaning up duplicate fields in the Advanced section.
- **`workers/tracker/index.ts` & `convex/tracking.ts`**: Bypassed legacy timestamp window correlation when claims exist (`!hasClaims(trackingId)`), eliminating false suppression of subsequent recipient opens.
- **`packages/agent`**: Added random entropy suffix to `jobId` generation to prevent same-millisecond ID collisions in tests.

#### Fixed
- **Background Content-Bridge Message Dispatch**: Fixed `REQUEST_SUMMARY`, `REQUEST_DRAFT`, and `GET_AI_JOB_STATUS` being discarded as unknown messages by checking `contentBridgeMessage` alongside Zod validation.
- **Message Self-View on Gmail Proxy URL**: Recognized saved message ID when Gmail rewrites original pixel URL to `ci3.googleusercontent.com/proxy/*`, preserving `PAGE_RELOAD` self-view suppression.
- **Pixel CDN Caching**: Added `CDN-Cache-Control: no-store`, `Cloudflare-CDN-Cache-Control: no-store`, dynamic UUID ETag, and `X-Content-Type-Options: nosniff` to tracker gif response.
- **Extension Bundle Size & Unused Plugin Warning**: Re-enabled `keepSingleOnnxWasm` plugin in `apps/extension/vite.config.ts`, stripping duplicate 27MB WASM from `dist/assets/` and resolving eslint unused-var warning.
- **InboxSDK Repeated "should not happen" Error**: Removed `sdk.NavMenu.addNavItem` splits from `mountSdkUi()`, preventing crashes on `#inbox` when Gmail's nav container is unavailable.
- **Duplicate InboxSDK Handler Registrations**: Consolidated handler ownership exclusively into `InboxSdkAdapter`, eliminating duplicate registration of `registerThreadViewHandler`, `registerMessageViewHandler`, `registerComposeViewHandler`, and `registerThreadRowViewHandler`.
- **Handler Stacking on Reload/Restart**: Tagged SDK instances with active registration state, ensuring handlers are registered strictly once per Gmail page lifecycle.
- **Missing Tracker Configuration in Settings**: Restored bundled tracker auto-loading (`tracker-config.json`) in background service worker and SettingsApp when tracker settings are unconfigured, resolving `Connection: Missing configuration`.
- **Delayed Gmail Pixel Open Regression**: Pixel arriving >8s after expansion now safely matches active or refreshed claim and is classified as `SELF_LIKELY`.
- **False Suppression of Real Recipient Opens**: Recipient opens arriving >1000ms after claim consumption are no longer swallowed by the legacy 8-second window.
- **Outdated Tracker Silent Failure**: Extensions now detect when deployed trackers lack self-view claims and flag the tracker as outdated.
- **Supabase Constraint Violations**: Runtime classifications `PROXY_LIKELY` and `MACHINE_LIKELY` are now valid enum values in Postgres.

### Verification Proof
- `npm test`: 35 test files passed, 348 tests passed.
- `npm run typecheck`: Passed with 0 TypeScript errors across all workspaces and Convex.
- `npm run lint`: Passed with 0 errors and 0 warnings across packages, apps, and workers.
- `npm run build`: Production build verified for all workspaces (`@gi/shared`, `@gi/gmail`, `@gi/mailbox`, `@gi/ai`, `@gi/search`, `@gi/agent`, `@gi/tracking`, `@gi/extension`, `@gi/tracker`).

---

## [0.1.0] — 2026-09-24

### Detailed Changes

#### Added
- **`apps/extension`**: Added `SelfViewDeduplicator` with multi-tier source priority (`MESSAGE_EXPANDED` / `MESSAGE_LOAD` > `ROW_INTERACTION`).
- **`apps/extension`**: Added unit tests in `apps/extension/src/content/self-view-dedupe.test.ts`.
- **`packages/shared`**: Added `PublicExtensionSettings`, `toPublicSettings()`, and `GET_PUBLIC_SETTINGS` runtime message schema.
- **`packages/mailbox`**: Added Dexie v4 migration with `resultId` index on `ai_jobs` table.
- **`packages/tracking`**, **`workers/tracker`**, **`convex`**: Added `ClickClassification` (`RECIPIENT_LIKELY`, `SELF_LIKELY`, `MACHINE_LIKELY`, `UNKNOWN`) and `classifyClick()` / `classifyClickEvent()`.
- **`apps/extension/manifest.json`**: Added `"https://*/*"` to `optional_host_permissions` for custom remote AI endpoints.

#### Changed / Refactored
- **`packages/tracking`**: Updated `deriveTrackingStats()` to increment `clickCount` only for `RECIPIENT_LIKELY` clicks; exposes `pixelLoadCount` and `possibleOpenCount`.
- **`workers/tracker` & `convex`**: In `handleSelfView` / `recordSelfView`, retroactively reclassifies correlated clicks within the self-view window to `SELF_LIKELY`.
- **`convex/tracking`**: Replaced `.take(200)` truncation with unbounded `getAllEventsForEmail()` collector while maintaining O(1) incremental counter updates.
- **`packages/ai`**: `AIJobQueue.enqueue` accepts `bypassCache`, `signal`, and `timeoutMs`, aborting provider requests on timeout and preventing late cache writes.
- **`packages/agent`**: `startSummaryJob` and `startDraftJob` pass `bypassCache: Boolean(input.force)`, enforce in-flight job ownership, and populate `resultId` on draft completion.
- **`apps/extension`**: Content script requests `GET_PUBLIC_SETTINGS` and isolates API tokens to background service worker.

#### Fixed
- **Thread ID Promise Equality Bug**: In `InboxSdkAdapter`, resolved canonical thread ID before destruction check, fixing `this.currentThread?.threadId !== threadView.getThreadID()` promise-vs-string bug.
- **Non-Thread Route Stale State**: Cleared `this.currentThread = null` when navigating to non-thread views (`inbox`, `search`, etc.).
- **Unchecked Router Goto**: Properly awaited `Promise.resolve(this.sdk.Router.goto?.(...))`.
- **Reinspection Timestamp Mutation**: In `message-self-view.ts`, preserved original `expandedAt` timestamp across view mutations during `reinspectActive()`.
- **Row Triage False Self-Opens**: Screened row interaction targets in `sent-status.ts` to ignore clicks on stars, checkboxes, action buttons, and chips.
- **Draft Status Resolution Race**: In background `GET_AI_JOB_STATUS`, checked `job.resultId` first before falling back to draft fingerprint search.
- **Bare Catches in Extension**: Replaced silent catch blocks in InboxSDK handler registration with structured bounded debug logs.

### Verification Proof
- `npm test`: 28 test files passed, 251 tests passed.
- `npm run typecheck`: Passed with 0 TypeScript errors across all workspaces.
- `npm run lint`: Passed with 0 errors across packages, apps, and workers.
- `npm run build`: Production build verified for all workspaces (`@gi/shared`, `@gi/gmail`, `@gi/mailbox`, `@gi/ai`, `@gi/search`, `@gi/agent`, `@gi/tracking`, `@gi/extension`, `@gi/tracker`).
