# PigeonBox server protocol

The protocol between the extension and your PigeonBox server is defined once, in `packages/api-contract` (`@pigeonbox/api-contract`). The extension's client (`@pigeonbox/cloud-client`) and the server (`packages/server`) both build from it. Code calls server mode `cloud`, which is why the package, message and capability names say `cloud`. To run a server, see [self-hosting.md](self-hosting.md).

## Principles

- **HTTP + JSON**, TLS only (plain HTTP is accepted only for a server on `127.0.0.1`/`localhost` during development).
- **Every request and response is validated** with Zod on both sides.
- **The server derives identity** from the access token. Request bodies never carry a user ID.
- **Mailbox content is processed, not stored.** AI routes carry email text; the server does not persist or log it. Always-on features (after a Google connection) store metadata and encrypted derived data; see [privacy-model.md](privacy-model.md).
- **Content scripts never call the server.** The background worker makes every server request. Gmail's content script may only ask the worker for read-only thread intelligence (`CLOUD_THREAD_INTEL`).

## Versioning and compatibility

- Clients send `x-pigeonbox-protocol: 1` (`PROTOCOL_VERSION`) on every request, plus `x-pigeonbox-client: extension/<version>` for diagnostics.
- The server accepts the versions in its `supported` list (`GET /v1/version`) and answers anything else with `426 unsupported_protocol`.
- The server may also set a minimum extension version. A request whose `x-pigeonbox-client` is `extension/X.Y.Z` below it gets `426 unsupported_protocol` with `error.minimumVersion`. Clients that send no parseable version (source builds, the dashboard) are not gated by version.
- The extension shows **PigeonBox needs an update** ("You're using PigeonBox 0.5.8. Your PigeonBox server requires 0.6.0 or newer.") with an Update action, sets the server status to `update_required`, and stops server polling and checks until it is updated. It never reports this as an outage. Local mode keeps working. A recommended (not required) version shows one quiet line and changes nothing else.
- Breaking changes (removed route, renamed field, new required request field, changed meaning) bump the version. Additive changes (routes, optional request fields, response fields, capabilities, error codes) do not.
- Clients ignore unknown response fields and capabilities. Error codes are parsed leniently.
- Drift guard: `packages/cloud-client/src/contract-compat.ts` fails `npm run typecheck` if the contract's AI request types stop matching the extension's `AIProvider` input types.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | none | Liveness |
| GET | `/v1/version` | none | Server version and supported protocol versions |
| GET | `/v1/client/config` | none | Remote client config (below). Global, never per user |
| GET | `/v1/auth/authorize` | none | Browser redirect: starts PKCE sign-in |
| POST | `/v1/auth/token` | none | Exchange `{ code, codeVerifier, redirectUri }` for a session |
| POST | `/v1/auth/refresh` | none | Exchange `{ refreshToken }` for a new session |
| POST | `/v1/auth/signout` | user | Revoke the session |
| GET | `/v1/me` | user | `{ user: { id, email } }` |
| GET | `/v1/capabilities` | user | `{ capabilities[] }` |
| GET | `/v1/account/entitlements` | user | Capabilities, limits, usage |
| POST | `/v1/account/delete` | user | `{ confirm: "delete my account" }`: deletes the account and all of its server data |
| POST | `/v1/ai/classify` | user, metered | `{ input: ClassifyInput }` → `ClassificationResult` |
| POST | `/v1/ai/summarize` | user, metered | `{ input: SummarizeInput }` → `ThreadSummary` |
| POST | `/v1/ai/draft` | user, metered | `{ input: DraftInput }` → `DraftSuggestion` |
| POST | `/v1/ai/follow-up` | user, metered | `{ input: DraftInput }` → `DraftSuggestion` |
| POST | `/v1/ai/rewrite` | user, metered | `{ input: RewriteInput }` → `string` |
| POST | `/v1/ai/ask` | user, metered | `{ input: AskInput }` → `AskOutput` |
| POST | `/v1/ai/embed` | user, metered | `{ texts[] }` → `number[][]` |

### Always-on intelligence (additive, protocol 1)

Available when the account has the matching capability (for example `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`). Every account on the server's `ALLOWED_EMAILS` list gets every capability the server is configured to serve; see [server/architecture.md](server/architecture.md#access-and-capabilities). The full list, with request and response schemas, is `ROUTES` in `packages/api-contract/src/routes.ts`.

| Area | Routes |
|---|---|
| Google connection | `/v1/connections`, `/v1/connections/google/start` (incremental features), `/update`, `/resync`, `/disconnect` |
| Thread state and drafts | `/v1/threads/intel`, `/v1/threads/state`, `/v1/focus/queue`, `/v1/drafts/get|prepare|place|feedback`, `/v1/followups/list|update` |
| Ask Pigeon | `/v1/ask` (answers with claims, sources and coverage) |
| Calendar and briefings | `/v1/calendar/availability|propose|events/prepare|events/create|meeting-brief`, `/v1/briefings/list|get|generate` |
| People and signals | `/v1/contacts/list|brief|update`, `/v1/contacts/radar`, `/v1/signals/thread` |
| Rules | `/v1/views…` (Smart Views with Shadow Mode), `/v1/automations…` |
| Approvals and audit | `/v1/approvals/list|decide`, `/v1/audit/list|undo` |
| Team, snippets, documents | `/v1/workspaces`, `/v1/team/…`, `/v1/snippets…`, `/v1/documents…` |
| Notifications | `/v1/notifications/list|ack` |
| Real-time Pidgy checks | `/v1/compose/check` (one clause of an unsent draft, ≤700 characters; answers `none`, `disabled` or one sourced notice; opt-in `memory.realtimeComposeChecks`) |

Writes that change Gmail or the calendar take an `idempotencyKey`. Sending and invitations are never executed directly: they create an approval, and only the signed-in person can decide it (API tokens cannot).

Gmail's content script never calls these routes. For real-time checks it sends `CLOUD_COMPOSE_CHECK` (one bounded clause) to the worker, which confirms server mode and the user's opt-in before calling `/v1/compose/check`, and returns only the advisory text, Gmail thread IDs and Google Calendar links.

In the extension, extension pages reach these routes through the worker's `CLOUD_CALL` message, which accepts only an allowlist (no account deletion, tokens or webhooks). The worker polls `/v1/notifications/list` every two minutes in server mode and shows approvals, due follow-ups, mentions, assignments and sync problems as desktop notifications if the person enabled them.

AI responses share one envelope: `{ result, usage: { inputTokens?, outputTokens?, totalTokens? }, model?, requestId? }`. Size limits are in `AI_LIMITS`.

The server tracker (`workers/server-tracker`) speaks the standalone tracker protocol (see [tracking.md](tracking.md)) at its own origin. Its management routes (`/api/emails…`, `/api/events/recent`) take the server access token as the Bearer credential, require the `cloud_tracking` capability (otherwise `402 entitlement_required`) and only ever see the caller's own records; `/open/:id` and `/c/:id` stay public and keep working for mail that was already sent, even after an account loses access. Only the service worker calls the management routes, through the server session's token provider. The tracker origin is a build setting (`VITE_PIGEONBOX_CLOUD_TRACKER_URL`) and is requested as an optional host permission when switching to server mode (the extension's `grant.html` window); if it changes, the dashboard's Email tracking page offers to grant the new origin.

## Remote client config

`GET /v1/client/config` returns `{ schema: 1, revision, ttlSeconds?, config }`. The schema, bounds and defaults are `packages/api-contract/src/client-config.ts`; the server builds the response from its `CLIENT_CONFIG` setting, validated with the same schema.

| Field | Bounds | Effect in the extension |
|---|---|---|
| `compose.idleMs` | 250–2000 (default 450) | Typing pause before a compose check |
| `compose.cooldownMs` | 1000–15000 (default 2800) | Minimum gap between checks in one composer |
| `compose.cacheMs` | 0–60000 (default 30000) | How long an answer is reused for the same clause |
| `compose.disabledKinds` | known notice kinds | Those notices are not shown |
| `notifications.pollMinutes` | 2–30 (default 2) | Server notification polling |
| `disabledFeatures` | `compose_checks`, `compose_completion`, `prepared_drafts`, `cloud_notifications` | Emergency off switch |
| `compatibility.minimumVersion`, `.recommendedVersion` | `X.Y.Z` | Update required / recommended |
| `notice.code` | `maintenance`, `degraded` | A fixed, extension-written line in the server status |
| `ttlSeconds` | 300–86400 (default 3600) | Cache lifetime |

Rules:

- **Only less, never more.** Config can switch client features off or slow them down within bounds. It cannot turn on anything the person has not turned on or the server does not serve, and server-side checks (opt-in, capabilities, `CLOUD_ROLLOUT`) still apply.
- **No code, URLs, routes, permissions, scopes, HTML, CSS or free text**, and no secrets. Messages are enum codes the extension words itself.
- **Fails safe.** A wrong `schema` is ignored as a whole; an out-of-bounds or malformed field falls back to its default on its own; unknown fields are dropped. The last good config is kept for up to 7 days when the server cannot be reached, and a failed fetch is not retried for 5 minutes. With no config at all the extension behaves exactly as the defaults above.
- **Server mode only.** Local mode never requests it.
- **Revision-aware.** Cached compose answers carry the config revision and are discarded when it changes.

The extension sends `x-pigeonbox-client: extension/<version>` on this request too, so the server can tell old and new clients apart; the response is the same for both.

## Sign-in

1. The worker creates a PKCE verifier and S256 challenge and a random `state`.
2. It opens `GET /v1/auth/authorize?redirect_uri=https://<extension-id>.chromiumapp.org/cloud&code_challenge=…&code_challenge_method=S256&state=…` with `chrome.identity.launchWebAuthFlow`.
3. The API checks the redirect URI against its allowlist (`ALLOWED_EXTENSION_IDS`, `ALLOWED_WEB_ORIGINS`) and forwards to the identity provider.
4. The browser returns to the redirect URI with `code` and `state`. The worker checks `state` and posts the code and verifier to `/v1/auth/token`.

## Errors

```json
{ "error": { "code": "entitlement_required", "message": "…", "retryable": false, "requestId": "req_…", "retryAfter": 30 } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | Body failed validation |
| `unauthenticated`, `invalid_token` | 401 | Missing or bad access token |
| `entitlement_required` | 402 | Account lacks the capability |
| `forbidden` | 403 | Not allowed, including an address that is not on the server's `ALLOWED_EMAILS` |
| `not_found` | 404 | |
| `payload_too_large` | 413 | |
| `unsupported_protocol` | 426 | Update the extension |
| `rate_limited`, `quota_exceeded` | 429 | Slow down / limit reached |
| `internal` | 500 | |
| `not_configured` | 501 | Server feature not configured |
| `provider_error`, `provider_invalid_response` | 502 | Inference provider failed |
| `provider_unavailable`, `provider_rate_limited` | 503 | |
| `provider_timeout` | 504 | |

The extension maps these to user-facing text with `cloudErrorMessage()`.

## Configuring the extension

A build without a server URL runs on this computer only (the GitHub release ZIP is such a build). A build is pointed at your server with public, build-time variables (see `apps/extension/.env.example`); `npm run server:deploy` writes them into `apps/extension/.env.local` and rebuilds:

```
VITE_PIGEONBOX_CLOUD_API_URL=https://api.example.com
VITE_PIGEONBOX_CLOUD_TRACKER_URL=https://t.example.com
# Optional, comma-separated: earlier hostnames of the same server tracker
VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS=https://tracker.example.workers.dev
```

Mail keeps the pixel and link URLs it was sent with, so moving the server tracker to a new hostname must keep the old one serving. List the old hostname in `VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS` so the extension still recognizes those pixels when you view your own sent mail (self-view suppression). Tracked emails are keyed to the server by API (`cloud:<API origin>`), not by tracker hostname, so their status, claims and activity keep working after the move.

Without rebuilding, the in-extension page `settings.html?here` → **Advanced → PigeonBox server URL** overrides the API URL. Only a loopback URL (for development, `http://127.0.0.1:8788`) also implies a tracker (`:8789`); otherwise the tracker URL and the dashboard's `externally_connectable` origin come from the build, so building with `npm run server:deploy` is the complete setup. These values are not secrets and no secret may ever be added to extension configuration.
