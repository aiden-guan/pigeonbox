# Server architecture

## Boundaries

The PigeonBox server is the optional backend of the same Chrome extension, built from this repository and deployed by you. "PigeonBox Intelligence" is not a separate application; "intelligence" here means the server-side AI, search and agent features that server mode adds to the extension. In code the mode is called `cloud`.

```
extension → @pigeonbox/cloud-client ──HTTPS + @pigeonbox/api-contract──▶ workers/api → packages/server → Supabase
          → @pigeonbox/tracking     ──tracker protocol v3──────────────▶ workers/server-tracker → packages/server → Supabase
```

- One extension. Server mode is a backend mode of that extension, reached over HTTPS with `@pigeonbox/api-contract`.
- `apps/web` is the dashboard: sign-in, connected Google accounts, privacy and data controls, approvals and server preferences. It is not a second mail client; the inbox experience stays in the extension.
- `packages/server` holds server logic only, with no UI. It imports the shared workspace packages (`api-contract`, `shared`, `ai`, `tracking`, `cloud-client` and the tracker handler from `workers/tracker`) directly.
- The extension never imports `packages/server`; `npm run check:repo` enforces that, so server code and its secret handling never ship in an extension build.
- Convex is not used by the server. It remains an optional backend for the standalone single-user tracker.

## Runtime

Two Cloudflare Workers sharing `packages/server`:

| Worker | Routes | Auth |
|---|---|---|
| `workers/api` | `/v1/*` (contract routes) and the dashboard's static assets from `apps/web/public` | Supabase access token (JWT) verified per request |
| `workers/server-tracker` | `/open/:id`, `/c/:id` (public), `/api/*` (management), `/health` | Supabase access token + `cloud_tracking` capability |

Supabase provides Auth (Google sign-in), Postgres with RLS, pgvector, Storage, Queues (pgmq) and Cron (pg_cron). No Supabase Edge Functions duplicate the Worker API. The API Worker also serves the dashboard at `/dashboard` (`/app` and `/` redirect there), the tracked-document viewer at `/d/*`, one-click unsubscribe at `/u/*`, the MCP endpoint at `/v1/mcp` and the Gmail push endpoint at `/v1/google/push`. A Cron trigger runs the API Worker every minute to drain durable jobs. The tracker can optionally route pixel and click events through a Cloudflare Queue, and the API Worker can optionally reach Postgres through Hyperdrive.

`npm run server:deploy` generates both Workers' configuration from `server.env`; see the [self-hosting guide](../self-hosting.md).

## Access and capabilities

There are no plans or payments. Two settings decide what an account gets:

- **Who:** `ALLOWED_EMAILS` (addresses, `@domain` entries, or `*` for anyone who can sign in; required in production, `*` by default in development). The auth provider is wrapped so that an identity not on the list can neither finish signing in nor use a token it already holds (`403 forbidden`). `getEntitlements` checks the list again, which also covers API tokens and background jobs of an account removed from it later.
- **What:** `servedCapabilities(config)` in `packages/server/src/config.ts`. Every allowed account gets every capability the server is configured for:

| Capability | Needs |
|---|---|
| `cloud_ai`, `cloud_tracking`, `ask_inbox` | Always |
| `cloud_team`, `cloud_mcp` | `DATABASE_URL` and `DATA_ENCRYPTION_KEYS` |
| `cloud_mail_sync`, `cloud_auto_drafts`, `cloud_automations`, `cloud_calendar`, `cloud_semantic_search`, `cloud_relationships` | The above plus the Google OAuth client and Pub/Sub settings |
| `cloud_sequences` | The always-on settings plus `SEQUENCES_ENABLED=true` |
| `cloud_documents` | Database, Supabase service key and `DOCUMENTS_BUCKET` |

A capability is never advertised without the infrastructure behind it. Safety limits still apply to every account; they protect the owner's AI spend (see [operations](operations.md#usage-and-cost)).

## Request pipeline (AI operations)

`packages/server/src/api.ts`:

1. **Protocol**: `x-pigeonbox-protocol` must be supported, else `426`.
2. **Validate** the body against the contract schema (size-capped; errors name paths, never values).
3. **Authenticate**: verify the bearer JWT (JWKS or HS256 for Supabase; HS256 for dev) and the access list. The user ID comes from the token only.
4. **Capabilities**: `getEntitlements(userId)` returns the served capabilities for an allowed account and none otherwise. No `cloud_ai` → `402`.
5. **Limits**: per-account daily requests (`CLOUD_AI_DAILY_REQUEST_LIMIT`), optional monthly tokens and monthly budget, the server-wide daily token budget.
6. **Rate limit**: per-account fixed window in Postgres (`hit_rate_limit`, `CLOUD_AI_RATE_LIMIT_PER_MINUTE`).
7. **Execute**: `@pigeonbox/ai` prompts, JSON repair and draft quality checks, with the server's `CloudInferenceBackend` as the completion function. Timeout per request.
8. **Meter**: `record_usage` (operation, provider, model, tokens, latency, status, request ID; never content).
9. **Validate the response** against the contract before sending.

## Modules (`packages/server/src`)

| Module | Responsibility |
|---|---|
| `config.ts` | Env → typed config and `servedCapabilities`. Production refuses mock AI, dev auth, the memory store, a missing salt or access list, and a non-HTTPS app URL |
| `auth.ts` | `AuthProvider` (Supabase, dev), PKCE brokering, redirect allowlist, token verification, the `ALLOWED_EMAILS` check |
| `entitlements.ts` | Capabilities and limits for an account: everything served for an allowed account, nothing otherwise |
| `ai/backends.ts` | `CloudInferenceBackend`: `mock`, `openai_compatible`, `cloudflare` (AI Gateway privacy headers), model fallback; turns a `ChatRequest` into Chat Completions parameters |
| `ai/policy.ts` | Inference settings: explicit reasoning effort per operation, processing tier per call (Standard when someone waits, Flex for background), soft background cost bands |
| `ai/json-schema.ts` | Zod schema → strict JSON Schema for native structured output (Zod still validates) |
| `ai/runner.ts` | Runs contract operations with the shared prompt library |
| `limits.ts` | Quotas, budget, rate limits, cost estimate |
| `store/` | `CloudStore` interface; Supabase (service role, every query user-scoped) and memory implementations |
| `tracker.ts` | The server tracker around the shared `handleTrackerRequest` with per-account stores. Pixel and click bookkeeping runs in `waitUntil` after the response; management requires `cloud_tracking`; public routes never check capabilities, so sent mail keeps working after an account loses access |
| `error-tracking.ts` | Optional, content-free error reports to Sentry when `SENTRY_DSN` is set |

## Data model

`supabase/migrations`:

- `profiles` (1:1 with `auth.users`).
- `usage_events`, `usage_daily`, `usage_global_daily`, `rate_limit_windows`.
- `tracked_emails`, `tracked_links`, `tracking_events`, `tracking_self_view_claims`, each with `user_id`. A trigger copies the owner from the tracked email onto child rows and rejects mismatches; ownership (`tracking_id`, `user_id`) is immutable on update, including an upsert's conflict branch. Counters on `tracked_emails` are recomputed by the tracker from all of an email's events (protocol v3 classification), never incremented. Engagement analytics read these counters only, so they exclude self views, delivery prefetches, scanners and unknown clients, and never present a pixel load as a human read.
- Every user-owned table references `profiles(id) on delete cascade`; account deletion removes all of the account's server data.
- RLS: enabled everywhere; clients may read their own rows and write nothing; service-only tables have no client policy.

The first migration also created billing tables, and a later one a launch waitlist; `20261029000000_remove_billing_and_waitlist.sql` drops them, so a fresh deployment ends up without them.

The always-on layer adds six migrations (`20260927000000`–`…0500`); see below.

## Privacy controls

- Request and response bodies are never logged. The logger only accepts metadata fields.
- With `CLOUD_AI_PROVIDER=cloudflare`, AI Gateway requests carry `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true` and `cf-aig-no-wholesale: true` (never fall back to Cloudflare Unified Billing); gateway metadata holds only operation and request ID.
- Provider error bodies and structured-output refusals are discarded (they can echo prompts).
- Usage rows have no content columns.

### Model settings

Product code names an operation (`classify`, `thread_analysis`, `research`, …) and never a model or provider parameter. `ai/policy.ts` maps each chat operation to a reasoning effort, and the backend turns that into provider parameters: `reasoning_effort` always, `temperature` only when reasoning is off, `max_completion_tokens` with headroom for reasoning, and a `response_format`. The model is `CLOUD_AI_PRIMARY_MODEL` for every operation, with optional `CLOUD_AI_FALLBACK_MODELS`, so a model change is configuration. Structured output is layered: native JSON output from the provider, then JSON extraction, Zod validation and one repair round trip.

## Always-on intelligence

Optional, enabled by configuration (see the [self-hosting guide](../self-hosting.md)). Each feature is served only when its settings are present (see Access and capabilities above).

### Modules

| Path | Responsibility |
|---|---|
| `db/` | `SqlDatabase`: `asUser(userId, fn)` runs a transaction as the restricted `pigeonbox_app` role with `app.user_id` set, so RLS scopes every query; `system(fn)` is used only for cross-tenant work (claiming jobs, routing Gmail pushes, resolving hashed tokens through security-definer functions). `attempt()` wraps statements that may fail in a savepoint. |
| `platform/` | `SecretBox` (AES-256-GCM, HKDF per-purpose subkeys, AAD binds user and record, key rotation), SSRF-safe fetch for webhooks and web research, concurrency helpers. |
| `google/` | OAuth (code + PKCE, incremental scopes), Gmail and Calendar REST clients, MIME building/parsing, Pub/Sub OIDC verification. |
| `jobs/` | Durable jobs: a `jobs` table plus a pgmq queue, idempotency keys, retry with jittered backoff, `PermanentJobError`, `RetryLaterError`, `DeferJob` (waiting without spending an attempt) and dead-lettering. Drained by the Worker cron trigger every minute and after Gmail pushes (`waitUntil`, best effort). |
| `intel/` | Always-on features: sync, thread analysis, prepared drafts and grounding, follow-ups, calendar, relationships, signals, Smart Views, automations, the policy engine and approvals, audit and undo, briefings, Ask Pigeon, teams, snippets, documents, sequences, API tokens and MCP, webhooks, privacy tools. |
| `routes/`, `control/` | Handlers for the contract and the dashboard's own routes (`/v1/control/*`). Every contract route has a handler (tested). |
| `evals/` | AI evals over synthetic fixtures through the real pipeline (mock model in `npm test`; a real provider with `npm run server:eval`). |
| `testing/` | PGlite with the real migrations, a fake Google (OAuth, Gmail history, Calendar, Pub/Sub), and a harness around the real router. Not part of the Worker build. |

### Data

| Migration | Tables |
|---|---|
| foundation | preferences, Google accounts, encrypted credentials, OAuth state, sync state, threads, message metadata (no bodies), jobs, audit events, notifications |
| thread intelligence | thread state (encrypted summaries), classifications, learned preferences, commitments, drafts and versions (sealed variants), follow-ups, reminders, writing profiles |
| automation and calendar | Smart Views, versions, matches, shadow decisions, automations and runs, approvals (sealed previews), tasks, notes, briefings, calendar cache, prepared events |
| search and relationships | `search_documents` (pgvector 768, derived text only), `recall_chunks` (Fast Recall, encrypted, expiring), contacts, companies, relationship events |
| teams | workspaces, members, invitations, shared threads, assignments, comments (encrypted), mentions, snippets |
| documents, sequences, API | documents and per-recipient links, document events, suppressions, sequences and sends, API tokens (hashed), idempotency keys, webhooks |

Structural tests (`migrations.test.ts`) fail the build if a table lacks RLS, if signed-out clients get any grant, if a user-owned table lacks a `pigeonbox_app` policy or a cascading owner key, or if a security-definer function has no pinned `search_path`.

### Flow

1. **Push**: Gmail publishes to Pub/Sub; the push is verified (Google-signed OIDC token, audience, service account) and routed to a `gmail.sync` job.
2. **Sync** walks Gmail history from the stored cursor (full recovery when it expired), stores metadata, and marks changed threads.
3. **Analysis** (`thread.analyze`) reads the thread from Gmail, combines deterministic heuristics with the model, and stores state, commitments and an encrypted summary. Email text is wrapped as untrusted data; injection attempts are flagged.
4. **Drafts** (`draft.prepare`) build a context pack (thread, history, calendar, profile), ask for up to three real variants, and run the grounding guard: unsupported prices, dates, times, links and numbers become placeholders. A draft the person edited in Gmail is never overwritten.
5. **Rules and automations** evaluate the thread; actions go through `performAction` and the policy engine (risk tiers 0–3, Shadow Mode, autonomy). Sending and invitations always create an approval; executing it re-checks that what is sent is exactly what was approved.
6. **Notifications** reach the dashboard, the extension (polling) and webhooks.
7. **Ambient compose Brain** (`POST /v1/compose/check`, opt-in `memory.realtimeComposeChecks`) checks one changed clause (<=700 characters), re-derived server-side. Existing free/busy, deadline, commitment and corrected-fact paths remain deterministic; exact owner/person/topic/mail/notes/interactions/future-event context runs before optional existing semantic retrieval. Strong selected proof alone can reach one model judgment (Standard, reasoning none, <=200 output tokens, no repair/fallback). Extractive assertions, source versions/revisions, user ownership, freshness and forget exclusions are validated before returning one quiet notice. Clause/query vectors are ephemeral. See [Ambient compose context](ambient-compose-context.md) for limits and the additive calendar-cache search migration.

### Logging

`consoleLogger` accepts a fixed set of fields, each matched against a safe pattern. `intel/logging.test.ts` pushes unique canaries (mail text, AI output, OAuth tokens, API tokens, link tokens, keys) through every path, including failures that echo content, and fails if any appears in a log call or on the console.
