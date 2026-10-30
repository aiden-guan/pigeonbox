# Server development

Everything runs locally without Supabase, Cloudflare or an AI provider: `npm run server:dev` uses `CLOUD_AI_PROVIDER=mock`, `AUTH_PROVIDER=dev` and an in-memory store (set in `workers/api/wrangler.toml`).

## Start

```bash
npm install
cp workers/api/.dev.vars.example workers/api/.dev.vars
# edit DEV_AUTH_SECRET and IP_HASH_SALT, then give the tracker the same values:
cp workers/api/.dev.vars workers/server-tracker/.dev.vars
npm run server:dev           # http://127.0.0.1:8788  API + dashboard
npm run server:dev:tracker   # http://127.0.0.1:8789  server tracker
```

Check it:

```bash
curl -s http://127.0.0.1:8788/v1/health
curl -s http://127.0.0.1:8788/v1/version
curl -s http://127.0.0.1:8789/health
```

Open http://127.0.0.1:8788, click **Sign in**, and enter any email. The development sign-in form exists only with `AUTH_PROVIDER=dev`, which production configuration refuses.

In development `ALLOWED_EMAILS` defaults to `*`, and every account gets the capabilities this configuration serves: AI, tracking and Ask without a database, more as you add the settings described in [architecture](architecture.md#access-and-capabilities). The API and tracker Workers each have their own in-memory store in development; with Supabase they share one database.

## With the extension

1. Build the extension (`npm run setup` or `npm run build`) and load `apps/extension/dist` unpacked. Note its ID on `chrome://extensions`.
2. Set `ALLOWED_EXTENSION_IDS=<that id>` in `workers/api/.dev.vars` and restart `npm run server:dev`.
3. Open Settings from the gear in the PigeonBox workspace in Gmail → **Advanced** → **PigeonBox server URL** = `http://127.0.0.1:8788`, Save. The tracker is then assumed at `:8789`. (Alternatively, set `VITE_PIGEONBOX_CLOUD_API_URL=http://127.0.0.1:8788` and `VITE_PIGEONBOX_CLOUD_TRACKER_URL=http://127.0.0.1:8789` in `apps/extension/.env.local` and rebuild.)
4. Under **How should PigeonBox run?**, choose **Your PigeonBox server**, agree, and **Sign in**. Chrome opens the development sign-in form in its auth window.
5. Summaries now come from the mock provider.

Fault injection with the mock provider: put `[[mock:429]]`, `[[mock:500]]`, `[[mock:timeout]]` or `[[mock:garbage]]` in an email body to see how the extension handles each failure.

## Tests

```bash
npm test                          # Vitest: the extension and server projects
npx vitest run --project server   # server tests only
npm run server:eval               # AI evals against CLOUD_AI_* from the environment, with a per-model telemetry table
npm run typecheck
npm run verify                    # everything CI runs
npx playwright install chromium
npm run test:server-browser       # dashboard tests: real router + PGlite + fake Google on loopback
npm run server:smoke              # read-only HTTPS checks against your deployed server
```

- `migrations.test.ts` applies `supabase/migrations` to PGlite (Postgres in WASM, with pgvector and stand-ins for Supabase's `auth` schema, pgmq and pg_cron), so SQL, RLS and the schema invariants are exercised without Docker. A global setup migrates once per run and caches a snapshot keyed by the migration contents; every test boots a copy.
- `intel/*.test.ts` are acceptance tests through the real router: `testing/intel-harness.ts` wires PGlite, a fake Google (`testing/fake-google.ts`: OAuth with PKCE and signed ID tokens, Gmail history, drafts, labels, send, Calendar, signed Pub/Sub pushes, failure injection) and a controllable clock. `connectedUser()` and `deliverAndSync()` set up most scenarios in two lines.
- `intel/logging.test.ts` is the privacy regression: it fails if any mail text, AI output, credential or secret reaches a log call or the console.
- `evals/` scores analysis, deadlines, commitments, scheduling, injection handling, draft grounding, placeholders, variant distinctness and the rule compilers over synthetic fixtures. They run on the mock model inside `npm test`. Safety metrics must be 100%.
- `test:server-browser` (`tests/server`, `playwright.server.config.ts`) covers PKCE dev sign-in, Overview/Focus, navigation, connections, approval edit/placeholder/reject gates, Ask citations, automation CRUD, preferences/privacy, documents, MCP setup, mobile navigation, outages and session refresh. It needs a local listen permission; CI installs Chromium and saves failure traces. `npx tsx scripts/server/browser-server.ts` opens the same seeded harness for UI work (port 8790, or `PIGEONBOX_BROWSER_PORT`); its `__fixture` endpoints never ship to Workers.
- `server:eval` refuses missing provider settings or `mock`; unavailable credentials are a BLOCKED result. Worker secrets cannot be downloaded, so supply the provider settings in your shell.
- `npm run server:deploy -- --dry-run` validates `server.env` and bundles both Workers locally without deploying anything.

## Always-on layer locally

The always-on features need Postgres and Google, so `npm run server:dev` leaves them off unless configured (the dashboard then shows them as unavailable). To run them:

1. Point `DATABASE_URL` in `workers/api/.dev.vars` at a Postgres database with the Supabase extensions (a local stack from the Supabase CLI, or a separate development project), apply `supabase/migrations` to it (for example with `supabase db push`), and set `DATA_ENCRYPTION_KEYS` to `k1:<base64 of 32 random bytes>`.
2. For Google, use a test project with your account as a test user, an OAuth client whose redirect URI is `http://127.0.0.1:8788/v1/connections/google/callback`, and a Pub/Sub push subscription pointed at a tunnel to `/v1/google/push`. Without push, `POST /v1/connections/resync` and the minute cron still keep mail current.

For UI work without Google, the browser harness above is the fastest way to get a realistic, seeded account: it runs the same router and migrations.

## Real Supabase in development

Use a local Supabase stack or a separate development project, apply `supabase/migrations`, and set `AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars` (these override the `[vars]` in `wrangler.toml`).
