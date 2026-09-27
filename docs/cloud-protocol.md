# PigeonBox Cloud protocol

The protocol between the extension and PigeonBox Cloud is defined once, in `packages/api-contract` (`@pigeonbox/api-contract`). The extension's client (`@pigeonbox/cloud-client`) and the Cloud server both build from it.

## Principles

- **HTTP + JSON**, TLS only (plain HTTP is accepted only for a server on `127.0.0.1`/`localhost` during development).
- **Every request and response is validated** with Zod on both sides.
- **The server derives identity** from the access token. Request bodies never carry a user ID.
- **Mailbox content is processed, not stored.** AI routes carry email text; the server does not persist or log it. Always-on features (after a Google connection) store metadata and encrypted derived data; see [privacy-model.md](privacy-model.md).
- **Content scripts never call Cloud.** The background worker makes every Cloud request. Gmail's content script may only ask the worker for read-only thread intelligence (`CLOUD_THREAD_INTEL`).

## Versioning and compatibility

- Clients send `x-pigeonbox-protocol: 1` (`PROTOCOL_VERSION`) on every request, plus `x-pigeonbox-client: extension/<version>` for diagnostics.
- The server accepts the versions in its `supported` list (`GET /v1/version`) and answers anything else with `426 unsupported_protocol`.
- Breaking changes (removed route, renamed field, new required request field, changed meaning) bump the version. Additive changes (routes, optional request fields, response fields, capabilities, error codes) do not.
- Clients ignore unknown response fields and capabilities. Error codes are parsed leniently.
- Drift guard: `packages/cloud-client/src/contract-compat.ts` fails `npm run typecheck` if the contract's AI request types stop matching the extension's `AIProvider` input types.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | none | Liveness |
| GET | `/v1/version` | none | Server version and supported protocol versions |
| GET | `/v1/auth/authorize` | none | Browser redirect: starts PKCE sign-in |
| POST | `/v1/auth/token` | none | Exchange `{ code, codeVerifier, redirectUri }` for a session |
| POST | `/v1/auth/refresh` | none | Exchange `{ refreshToken }` for a new session |
| POST | `/v1/auth/signout` | user | Revoke the session |
| GET | `/v1/me` | user | User, plan, subscription status |
| GET | `/v1/capabilities` | user | `{ plan, capabilities[] }` |
| GET | `/v1/account/entitlements` | user | Capabilities, limits, usage |
| POST | `/v1/account/delete` | user | `{ confirm: "delete my account" }`: deletes the account and its Cloud data, cancels the subscription |
| POST | `/v1/billing/checkout` | user | Stripe Checkout URL |
| POST | `/v1/billing/portal` | user | Stripe Customer Portal URL |
| POST | `/v1/ai/classify` | user, metered | `{ input: ClassifyInput }` → `ClassificationResult` |
| POST | `/v1/ai/summarize` | user, metered | `{ input: SummarizeInput }` → `ThreadSummary` |
| POST | `/v1/ai/draft` | user, metered | `{ input: DraftInput }` → `DraftSuggestion` |
| POST | `/v1/ai/follow-up` | user, metered | `{ input: DraftInput }` → `DraftSuggestion` |
| POST | `/v1/ai/rewrite` | user, metered | `{ input: RewriteInput }` → `string` |
| POST | `/v1/ai/ask` | user, metered | `{ input: AskInput }` → `AskOutput` |
| POST | `/v1/ai/embed` | user, metered | `{ texts[] }` → `number[][]` |

### Always-on intelligence (additive, protocol 1)

Available when the account has the matching capability (for example `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`). The full list, with request and response schemas, is `ROUTES` in `packages/api-contract/src/routes.ts`.

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

Writes that change Gmail or the calendar take an `idempotencyKey`. Sending and invitations are never executed directly: they create an approval, and only the signed-in person can decide it (API tokens cannot).

In the extension, extension pages reach these routes through the worker's `CLOUD_CALL` message, which accepts only an allowlist (no billing, account deletion or token management). The worker polls `/v1/notifications/list` every two minutes in Cloud mode and shows approvals, due follow-ups, mentions, assignments and sync problems as desktop notifications if the person enabled them.

AI responses share one envelope: `{ result, usage: { inputTokens?, outputTokens?, totalTokens? }, model?, requestId? }`. Size limits are in `AI_LIMITS`.

The hosted tracker speaks the self-host tracker protocol (see [tracking.md](tracking.md)) at its own origin. Its management routes (`/api/emails…`, `/api/events/recent`) take the Cloud access token as the Bearer credential; `/open/:id` and `/c/:id` stay public.

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
| `forbidden` | 403 | Not allowed |
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

Cloud is off in source builds. A build enables it with public, build-time variables (see `apps/extension/.env.example`):

```
VITE_PIGEONBOX_CLOUD_API_URL=https://api.example.com
VITE_PIGEONBOX_CLOUD_TRACKER_URL=https://t.example.com
```

For development, **Settings → Advanced → PigeonBox Cloud API URL** can point at `http://127.0.0.1:8788`; the tracker is then assumed at `:8789`. These values are not secrets and no secret may ever be added to extension configuration.
