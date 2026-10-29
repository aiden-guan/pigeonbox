# Operations

Running your PigeonBox server after the first deploy. Settings live in `server.env`; generated secrets (encryption keyring, salts) in `.local/server-secrets.json`. `npm run server:deploy` applies new migrations and redeploys both Workers, so a settings change or an update is: edit `server.env` (or `git pull`), then run it again. `npm run server:smoke` repeats the read-only checks the deploy ends with. Setup itself is in the [self-hosting guide](../self-hosting.md).

## Logs and monitoring

- Workers emit one JSON line per request: `requestId`, route, status, latency, and for AI operations user ID, operation, provider, model and token counts; jobs log kind, attempt and error codes. Never bodies, prompts, AI output, email addresses from mail, or tokens (enforced by `sanitizeLogFields` and a regression test).
- The generated Worker configuration turns on Workers Logs for the sanitized application logger and turns automatic invocation logs off, because request URLs may contain OAuth or document credentials. Keep that setting if you add Logpush or another log store. Useful alerts: 5xx rate, `provider_*` error rate, p95 latency.
- With `CLOUD_AI_PROVIDER=cloudflare`, AI Gateway analytics give per-model cost and errors. Spend alerts belong there and with your AI provider.
- Error tracking (optional): Sentry, off unless a Worker has the `SENTRY_DSN` secret. `npm run server:deploy` does not set it; add it with `npx wrangler secret put SENTRY_DSN --config .local/wrangler/api.toml` (and `.local/wrangler/tracker.toml` for the tracker). Redeploys keep it: the deploy script adds its own secrets and never removes others. `packages/server/src/error-tracking.ts` posts envelopes directly (no SDK) for error-level log lines only: unhandled API/tracker errors, dead-lettered jobs, failed cron drains, jobs with no handler. An event holds the fixed log message, the sanitized `route`, `code`, `jobKind`, `operation`, `provider`, `model`, `status` and `attempt` tags, `requestId` (to find the Workers Logs line), and for exceptions the error class name and stack frame locations. Exception messages, URLs and query strings, headers, bodies, cookies, user/account/job IDs, breadcrumbs and IP addresses are never sent (regression test in `error-tracking.test.ts`). Each isolate sends one event per fingerprint per minute and at most 10 per flush; outages are absorbed. In the Sentry project, consider turning on "Prevent Storing of IP Addresses" and a data-scrubbing rule for the location Sentry derives from the sending connection (that is a Cloudflare server, never a user).

## Usage and cost

`usage_events` has one row per AI request. Useful queries:

```sql
-- Today's tokens by model
select model, sum(input_tokens + output_tokens) from usage_events
where created_at >= date_trunc('day', now()) group by 1 order by 2 desc;

-- Cost and latency by operation this week (estimated_cost_micros uses CLOUD_AI_*_COST_PER_1K_MICROS)
select operation, model, count(*), sum(input_tokens) as input, sum(output_tokens) as output,
       sum(estimated_cost_micros) / 1e6 as est_usd,
       percentile_disc(0.95) within group (order by latency_ms) as p95_ms
from usage_events where created_at >= now() - interval '7 days' group by 1, 2 order by est_usd desc;

-- Heaviest accounts this month
select user_id, sum(tokens) from usage_daily where day >= date_trunc('month', now()) group by 1 order by 2 desc limit 20;
```

Estimated costs are zero unless you set `CLOUD_AI_INPUT_COST_PER_1K_MICROS` and `CLOUD_AI_OUTPUT_COST_PER_1K_MICROS` to your provider's prices.

Safety limits, all set in `server.env`:

| Setting | Default | Effect |
|---|---|---|
| `CLOUD_AI_DAILY_REQUEST_LIMIT` | 500 | AI requests per account per day |
| `CLOUD_AI_RATE_LIMIT_PER_MINUTE` | 30 | AI requests per account per minute |
| `CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET` | 50,000,000 | Tokens per UTC day across the whole server |
| `CLOUD_AI_BACKGROUND_DAILY_LIMIT` | 1,500 | Background AI (analysis, auto drafts, briefings) per account per day |
| `CLOUD_AI_MONTHLY_BUDGET_MICROS` | 0 (off) | Estimated spend per account per month; needs the cost settings above |
| `CLOUD_AI_MONTHLY_TOKEN_LIMIT` | 0 (off) | Tokens per account per month |

Output tokens include the model's reasoning tokens. Reasoning effort is set per operation in `packages/server/src/ai/policy.ts` (none for classify, rewrite, rule matching and Ask Pigeon's tool rounds; low for summaries, drafts, analysis, memory extraction, snippets and Ask). Raising an effort raises output tokens and latency for that operation. Check both with the query above and with the evals before changing one.

Processing tier is separate from reasoning effort. Calls where someone is waiting (the extension's operations, Ask Pigeon, user-requested drafts, rewrites, view compiles, snippets) run on Standard. Background work (thread analysis, memory extraction, auto and follow-up drafts) runs on OpenAI's Flex tier by default, priced at Flex rates in `usage_events` and the monthly budget. A Flex capacity error (429 `resource_unavailable`) or timeout makes the job retry with exponential backoff on Flex; thread analysis falls back to rules only on its last attempt. Rule and automation AI matching stays on Standard (it cannot be retried later). Set `CLOUD_AI_BACKGROUND_TIER=standard` to turn Flex off, for example when your provider has no Flex tier. Logs `intel ai operation` carry `reasoningEffort`, `serviceTier`, `actualServiceTier`, `cachedTokens`, `costMicros` and `latencyMs`; the AI Gateway metadata carries `serviceTier` and `reasoningEffort` too.

With a monthly budget set, background work also slows as an account's month gets expensive (`backgroundAllowance` in `policy.ts`): at 62.5% of `CLOUD_AI_MONTHLY_BUDGET_MICROS` memory learning pauses and the background daily limit halves, at 70% it drops to a quarter, and at 87.5% background AI stops (analysis falls back to rules). Interactive use continues until the hard budget.

When `CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET` is reached, the server stops all AI for the rest of the UTC day and answers with a capacity error. Local mode is unaffected.

## Comparing models

The evals are the gate for any model or reasoning-policy change. Run them once per candidate with the candidate's settings in the environment:

```bash
CLOUD_AI_PROVIDER=openai_compatible CLOUD_AI_BASE_URL=... CLOUD_AI_API_KEY=... \
CLOUD_AI_PRIMARY_MODEL=<candidate model> CLOUD_AI_FALLBACK_MODELS= \
CLOUD_AI_INPUT_COST_PER_1K_MICROS=<price> CLOUD_AI_OUTPUT_COST_PER_1K_MICROS=<price> \
npm run server:eval
```

After the metric table, the run prints a telemetry table built from the usage rows it recorded: per model and operation, calls, errors, input and output tokens, p50/p95 latency, estimated cost, and the pass rate of the checks that grade that operation. It holds no prompts or outputs. Compare tables across runs; safety metrics must stay at 100%. `npx vitest run packages/server/src/evals` prints the same table for the mock model and needs no credentials.

## Housekeeping

The daily `retention.sweep` job (scheduled by Supabase Cron, run by the Worker) deletes expired Fast Recall excerpts, notifications older than 90 days, ordinary write-response idempotency keys older than 30 days and rate-limit windows older than a day. Irreversible-action reservations are retained until account deletion so a delayed queue retry cannot resend an action after an uncertain provider response or post-send crash.

## Background jobs

Jobs live in `public.jobs` (state) and the `pigeonbox_jobs` pgmq queue (delivery). Supabase Cron enqueues scheduled work every 15 minutes; the API Worker's Cron trigger drains the queue every minute; Gmail pushes durably enqueue and acknowledge. HTTP post-response work must not claim long recovery/analysis jobs.

The always-on Gmail layer needs the Workers Paid plan once a mailbox is busy: Free cron invocations get 10 ms of CPU. Set `WORKERS_PAID=true` in `server.env` and redeploy; the generated configuration then raises the CPU limit to 30 seconds and the subrequest limit. If scheduled invocations repeatedly terminate as `exceededCpu` near 10 ms, check in the Cloudflare dashboard (Workers & Pages) that Workers Paid is active on the account you deployed to. A `standard` usage model, accepted configured limits and an occasional successful invocation do not prove the subscription is active. [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/) document 10 ms for Free cron invocations and 30 seconds for Paid cron intervals under one hour, with limited flexibility for occasional CPU bursts. If you ask Cloudflare support, share only timestamp, outcome, `cpuTime`, `wallTime`, execution model and script version. Do not upload raw tail output: it can contain credential-bearing request URLs even when automatic invocation logging is disabled. Do not mask the problem with faster crons, fresh-isolate deployments or deleting failed jobs. After the runtime is fixed, retry affected jobs with normal idempotent enqueue semantics and verify the queue drains without new lease losses.

Each claimed batch reserves one slot for visible Gmail work; remaining slots stay FIFO so analysis/drafts/indexing continue. Migration `20260930000100_sync_queue_fairness.sql` labels sync queue envelopes and uses the installed pgmq conditional read API. This prevents an initial analysis backlog from starving recovery and incremental sync, while pgmq retains leases and locks.

```sql
-- Backlog and failures by kind
select kind, status, count(*) from public.jobs where created_at > now() - interval '1 day' group by 1, 2 order by 1, 2;

-- Dead-lettered jobs (codes only; no content is stored)
select kind, last_error_code, count(*) from public.jobs where status = 'dead' group by 1, 2 order by 3 desc;

-- Lease losses and delayed work (no payloads)
select kind, status, count(*), max(attempts), min(run_at), min(locked_until)
from public.jobs where status in ('queued','retrying','running') group by 1,2;

-- Stale connections and coverage (no addresses or content)
select state, last_error_code, consecutive_failures, last_sync_completed_at,
       coverage_since, last_push_at, watch_expires_at
from public.gmail_sync_state;

-- Detect the historical postgres.js JSON encoding defect
select kind, jsonb_typeof(payload), count(*) from public.jobs group by 1,2;
```

Recovery logs profile/credential refresh stages, page-listed/message counts, page persistence and pass completion. Errors distinguish `google_subrequest_limit`, `google_timeout`, rate limits and generic network errors without exception text. OAuth exchanges and Gmail reads have a 20-second timeout. A scheduled drain failure emits only `job_drain_failed`; never log a raw database exception because it can contain SQL parameter values.

Migration `20260930000000_repair_double_encoded_json.sql` restores only encoded object/array containers and requeues analysis previously skipped by missing IDs. Malformed or scalar JSON is preserved. The postgres adapter serializes already-encoded `toSqlParam` JSON once, with a database regression for both payload objects and arrays. Do not clear historical dead jobs to hide incidents.

Suggested alerts: any increasing dead-job count; oldest due job >10 minutes; running jobs beyond their lease; active connection with no completed sync for 6 hours; elevated API 5xx; provider errors; daily token/cost budget near its limit. These thresholds are guidance; you configure alert destinations yourself.

A dead job can be retried by re-enqueuing its kind and payload with a new idempotency key; most kinds are also re-triggered naturally (the next push, cron or calendar refresh). Alert on a growing `queued` count or any `dead` rate above a few per hour.

## Health model

`GET /v1/control/health` (`packages/server/src/intel/health.ts`) derives one status from existing state on every read; nothing is stored. Levels, worst first: `failed`, `action_required`, `stale`, `degraded`, `syncing`, `healthy`. The dashboard shows the title ("Everything is up to date", "PigeonBox is catching up", "Reconnect Google", "Some background work is delayed", "Mail may be out of date") and plain reasons; fixed reason codes (`mail_push_unprocessed`, `mail_sync_overdue`, `calendar_stale`, `analysis_delayed`, …) are in the response for operators and tests. Mail is only `healthy` when Gmail's latest pushed history has been processed, a sync completed within 7 hours, and no sync work is queued: a `healthy` value in `gmail_sync_state.state` alone is not enough. Thresholds are `HEALTH_THRESHOLDS` in that file.

## Rollout and kill switches

Optional AI behaviors can be narrowed or turned off per cohort without an extension release (`packages/server/src/rollout.ts`). Capabilities are unchanged; the server simply does less.

| Feature | Off means |
| --- | --- |
| `compose_checks` | `/v1/compose/check` answers `disabled` (the installed extension backs off) |
| `compose_semantic` | compose checks skip embedding retrieval; exact and calendar checks remain |
| `compose_completion` | no smart compose completions |
| `memory_learning` | `memory.extract` jobs are skipped; existing memories stay readable and forgettable |
| `auto_drafts` | analysis no longer queues reply/scheduling drafts; a person can still ask for one |
| `followup_drafts` | follow-ups still alert, without a prepared draft |
| `briefings` | scheduled briefing jobs are skipped |

Stages: `off`, `internal`, `early_beta`, `beta` (every allowed account). Cohorts come from the Worker vars `CLOUD_INTERNAL_USER_IDS` and `CLOUD_EARLY_BETA_USER_IDS` (comma-separated Supabase user IDs); everyone else is `beta`. Unset means every feature at `beta`. `npm run server:deploy` copies `CLOUD_ROLLOUT` from `server.env` but not the cohort lists, so with the deploy script use `off` and `beta`.

```bash
# Emergency: turn semantic compose retrieval off for everyone.
# In server.env:
#   CLOUD_ROLLOUT=compose_semantic=off
npm run server:deploy
```

A mistyped stage turns that one feature off and logs `rollout config ignored entries`; an unknown feature name is ignored and logged.

## Compose notice policy

Each notice category has its own minimum confidence (`packages/server/src/intel/compose-policy.ts`): contradictions 0.90, overlooked context 0.93, helpful context and writing suggestions 0.96. `COMPOSE_NOTICE_POLICY` in `server.env` can tighten a category or turn it off, e.g. `COMPOSE_NOTICE_POLICY=helpful_context=0.98,writing_suggestion=off`; it can never lower a threshold (that needs a code change and an eval run). A held-back notice is logged as `outcome: notice_held` with its category.

## Extension client config

`GET /v1/client/config` (no sign-in) serves `CLIENT_CONFIG`, a JSON object the extension (0.6.0 and later) reads every 15 minutes at most. It can only make the extension do less or tune it within fixed bounds; it never carries URLs, routes, permissions, HTML, scripts or secrets. The schema, bounds and allowlists are in `@pigeonbox/api-contract` (`client-config.ts`, documented in [cloud-protocol.md](../cloud-protocol.md#remote-client-config)). A value that fails the schema is ignored as a whole (the extension keeps its defaults) and logged once per isolate as `client config ignored` (`client_config_invalid`).

```bash
# In server.env, then npm run server:deploy.
# Turn smart compose completions off and show the maintenance notice:
CLIENT_CONFIG='{"disabledFeatures":["compose_completion"],"notice":{"code":"maintenance"}}'
# Slow compose checks down under load:
CLIENT_CONFIG='{"compose":{"idleMs":900,"cooldownMs":6000}}'
```

`compatibility.minimumVersion` is also enforced here: a request whose `x-pigeonbox-client` is `extension/X.Y.Z` below it gets 426 `unsupported_protocol` with `minimumVersion` in the error body, and 0.6.0+ shows "PigeonBox needs an update". Sign-out, memory forget/purge and account deletion stay open to outdated extensions; the dashboard and API tokens are never gated. Extensions before 0.6.0 show such a 426 as "unreachable", so raise the minimum only after the extensions that use your server are updated. `compatibility.recommendedVersion` only shows a soft update prompt.

The revision is a hash of the parsed config, so any change reaches clients on their next fetch. Like `CLOUD_ROLLOUT`, a change deploys a new Worker version.

## Notification budget

Approvals, sync/re-auth problems, mentions and assignments always notify. Routine kinds are budgeted per person per 20 hours (`NOTIFICATION_BUDGET` in `intel/notifications.ts`): after 5 `draft_ready` or 6 `engagement` notices the rest roll into one digest per kind and day, updated in place and marked unread. Follow-ups keep their own cap (3 alerts, 5 drafts) and digest. Replays of the same dedupe key never spend budget.

## Auto-draft policy

Before analysis queues a background draft, `intel/draft-policy.ts` decides whether one is worth preparing. It skips suspected injection, uncertain requests (analysis confidence < 0.6), threads with more than four other people, a `review`/`send_deliverable` next action, sensitive content, negotiation or conflict wording, more than three questions in the new text, and more than 8 auto drafts per person in 20 hours. Each decision logs `auto draft decision` with `decision` and a reason `code`; no content.

## Google connections

- **Reconnect needed** (`mail_accounts.status = 'needs_reauth'`): Google rejected the refresh credential (password change, revoked access). Sync stops for that account and the person sees it in the dashboard and extension; nothing else is affected.
- **Watch renewal**: Gmail watches expire after 7 days. Every 15 minutes Cron renews any watch within a day of expiry, and re-syncs accounts that have not synced for 6 hours as a safety net. `gmail_sync_state.watch_expires_at` shows each account's expiry.
- **History expired**: when Gmail's history cursor is too old, sync switches to a bounded recovery (`gmail.recover`) automatically.
- **Pub/Sub outage**: the minute cron and resyncs keep mail current, more slowly.

## Encryption keys

`DATA_ENCRYPTION_KEYS` is a keyring (`kid:base64(32 bytes)`, comma-separated; the first key encrypts, all keys decrypt). `npm run server:deploy` generates the first key into `.local/server-secrets.json` and reuses it on every deploy. Back that file up: without it, the mail data your server stores cannot be read.

To rotate, prepend a new key to `DATA_ENCRYPTION_KEYS` in `.local/server-secrets.json` and redeploy: new records use it and older records stay readable. Remove an old key only after re-encrypting its records. Never remove every key: sealed summaries, drafts, notes and Google credentials would become unreadable (people would need to reconnect Google).

## Incidents

- **Server down**: extensions in server mode show "Your PigeonBox server is unavailable. Nothing was sent to another provider." On-device sorting continues. People can switch to running on this computer at any time; nothing switches automatically.
- **AI provider down**: models in `CLOUD_AI_FALLBACK_MODELS` are tried for 429/5xx/timeouts; a rejected request (other 4xx) is not retried. With no fallback model (the default), provider errors reach people as `provider_*` codes and nothing is sent to another model or to Local mode. To move traffic, change `CLOUD_AI_PRIMARY_MODEL`/`CLOUD_AI_BASE_URL` in `server.env` and redeploy (no extension release).
- **AI Gateway 400s after a key change** (`CLOUD_AI_PROVIDER=cloudflare`): "Require provider credentials" / `cf-aig-no-wholesale` rejects requests without a provider credential rather than billing Cloudflare credits. Check `CLOUD_AI_API_KEY` or the gateway's stored provider key.
- **Leaked secret**: rotate it with its provider (Supabase, your AI provider, Google), update `server.env`, and run `npm run server:deploy`. For `DATA_ENCRYPTION_KEYS`, follow the rotation above instead of replacing the key. The extension holds no server secrets.

## Access and data deletion

Removing an address from `ALLOWED_EMAILS` (and redeploying) stops that account from signing in or using a token it already holds, and its capabilities drop to none. Its stored data stays until the account is deleted.

`POST /v1/account/delete` revokes and deletes Google credentials, deletes tracked-document files, deletes the profile (cascading to every user-owned table: usage, tracking, synced mail data, drafts, rules, documents, tokens) and deletes the Supabase Auth user. The dashboard's Privacy & data section can delete only synced mail data, and disconnecting an account revokes that account's access.
