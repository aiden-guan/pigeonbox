# Self-hosting PigeonBox

PigeonBox has no hosted service. Everything runs on your computer or on accounts you own.

| What you want | What you run | Accounts you need |
| :--- | :--- | :--- |
| Inbox triage, briefs, drafts and chat with local or bring-your-own-key AI | The extension only: `npm run setup` | None |
| Read receipts (opens and clicks) | The extension and a tracker: `npm run setup:tracker` ([Convex guide](convex-self-hosting.md)) | Convex (free tier) |
| Everything: AI on your server, tracking, tracked PDFs, Ask over all your mail, and the always-on Gmail layer (background sync, prepared drafts, follow-ups, briefings, Smart Views, automations, calendar help) | The extension and **your PigeonBox server**: `npm run server:deploy` (this guide) | Cloudflare, Supabase, Google Cloud, an AI provider |

Start with the extension. Add a server when you want the features in the last row. A server includes its own tracker, so you don't need the Convex one as well.

## What the server is

```text
Chrome extension ──HTTPS──▶ workers/api           (Cloudflare Worker: /v1 API + dashboard at /dashboard)
                 ──HTTPS──▶ workers/server-tracker (Cloudflare Worker: pixels, clicks, tracking API)
                                   │
                                   ▼
                     Supabase: Auth (Google sign-in), Postgres + RLS, pgvector,
                     Queues (pgmq), Cron (pg_cron), Storage (tracked PDFs)
                                   │
              your AI provider ◀───┴───▶ Google: Gmail and Calendar APIs, Pub/Sub push
```

The code is `packages/server`, deployed as the two Workers. The database schema is `supabase/migrations`. The dashboard is `apps/web`. The extension still calls this "Cloud" mode internally (`runMode: 'cloud'`); in the product it is "your PigeonBox server".

**Who can use it.** `ALLOWED_EMAILS` lists the addresses (or `@domains`) allowed to sign in. Everyone on the list gets every feature your server is configured for; there are no plans. Anyone you allow spends your AI credits, so keep the list short. `*` allows anyone who can sign in with Google.

**Cost.** Cloudflare's and Supabase's free tiers are enough to sign in, use AI and track mail. The always-on Gmail layer makes many API calls per mailbox, so set `WORKERS_PAID=true` once you're on Cloudflare's Workers Paid plan ($5/month). AI usage is billed by your provider. The server has per-account limits you can tune (below).

## Before you start

- PigeonBox built from source: `npm run setup` ([local setup](local-setup.md)). Node.js from [.nvmrc](../.nvmrc).
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account. Log in once from this checkout: `npx wrangler login`.
- A [Supabase](https://supabase.com/dashboard) project.
- A [Google Cloud](https://console.cloud.google.com/) project for Google sign-in (and, optionally, Gmail access).
- An API key for an OpenAI-compatible chat and embeddings endpoint (OpenAI, or a compatible gateway).

## 1. Create the Supabase project

1. Create a project and note its database password.
2. **Project Settings → API**: copy the project URL, the `anon` (publishable) key and the `service_role` (secret) key.
3. **Connect → Transaction pooler**: copy the connection string (port 6543) and put your database password in it.

The deploy script applies the migrations; they enable the extensions they need (`pgmq`, `pg_cron`, `vector`).

## 2. Create the Google OAuth client

PigeonBox signs you in with Google through Supabase Auth.

1. In Google Cloud, open **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name and your email, and add yourself (and anyone on `ALLOWED_EMAILS`) as a test user.
2. **Credentials → Create credentials → OAuth client ID → Web application.** Add this authorized redirect URI:
   `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
3. Copy the client ID and secret.

## 3. Fill in `server.env`

```bash
cp server.env.example server.env
```

Fill in the required values in `server.env`, plus `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Every setting is described in [server.env.example](../server.env.example). `server.env` is gitignored.

Optionally, add a Supabase personal access token (`SUPABASE_ACCESS_TOKEN`, from **Account → Access Tokens**). The deploy script then configures Supabase Auth for you. Without it, the script prints the two settings to make by hand.

## 4. Deploy

```bash
npm run server:deploy
```

The script:

1. generates the server's encryption key, salts and job secret into `.local/server-secrets.json` (once; **back this file up**, because without it the mail data your server stores can't be decrypted),
2. gives your unpacked extension a stable ID (a key in `apps/extension/.env.local`) so the server can allow it to sign in,
3. applies `supabase/migrations` to your database and creates the tracked-PDF bucket if you set one,
4. deploys `pigeonbox-tracker` and `pigeonbox-api` to your `workers.dev` subdomain, with their secrets,
5. configures Supabase Auth's redirect URLs and Google provider (with `SUPABASE_ACCESS_TOKEN`) or tells you what to set,
6. writes the server's addresses into `apps/extension/.env.local` and rebuilds the extension,
7. runs `npm run server:smoke` against the deployment.

To check `server.env` and bundle both Workers without deploying anything, run `npm run server:deploy -- --dry-run`.

> **The extension ID changes once.** If you had already loaded PigeonBox unpacked without a key, Chrome treats the rebuilt extension as new: local settings and the local index start fresh. To keep the old ID instead, set `EXTENSION_ID` in `server.env` (from `chrome://extensions`) before the first deploy.

## 5. Sign in

1. If the script printed Supabase settings, make them now: **Authentication → URL Configuration** (Site URL and Redirect URLs) and **Authentication → Sign In / Providers → Google** (your client ID and secret).
2. Reload PigeonBox in `chrome://extensions` (or **Load unpacked → `apps/extension/dist`**).
3. Open Gmail, choose **Your PigeonBox server** in PigeonBox, and sign in with an address on `ALLOWED_EMAILS`.
4. The dashboard is at `https://pigeonbox-api.<your-subdomain>.workers.dev/dashboard`.

AI, tracking and Ask now run on your server.

## Always-on Gmail

Background sync, prepared drafts, follow-ups, briefings, Smart Views, automations, calendar help and Ask over all your mail need the server to read Gmail while Gmail is closed. This uses the Gmail API with push notifications.

1. In the same Google Cloud project, enable the **Gmail API**, **Google Calendar API** and **Cloud Pub/Sub API**.
2. On the OAuth client, add a second authorized redirect URI:
   `https://pigeonbox-api.<your-subdomain>.workers.dev/v1/connections/google/callback`
3. On the OAuth consent screen, add the scopes PigeonBox requests (each only when you turn on the matching feature): `gmail.readonly`, `gmail.compose`, `gmail.modify`, `gmail.send`, `calendar.readonly`, `calendar.events`, plus `openid`, `email` and `profile`.
4. **Pub/Sub → Topics → Create topic** (for example `gmail-push`). On the topic, grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role.
5. **IAM → Service accounts → Create** a service account (for example `gmail-push`). It signs the push requests; it needs no roles.
6. On the topic, **Create subscription**: delivery type **Push**, endpoint `https://pigeonbox-api.<your-subdomain>.workers.dev/v1/google/push`, **Enable authentication** with that service account, and the same URL as the audience.
7. In `server.env`, set `GOOGLE_PUBSUB_TOPIC=projects/<project-id>/topics/gmail-push` and `GOOGLE_PUBSUB_SERVICE_ACCOUNT=gmail-push@<project-id>.iam.gserviceaccount.com`, then run `npm run server:deploy` again.
8. In the dashboard, connect your Google account and choose what PigeonBox may do.

**Google's limits on unverified apps.** Gmail read, modify and send are restricted scopes. While your consent screen is in **Testing**, Google lets your listed test users connect but expires the grant after 7 days, so you reconnect weekly. Publishing the app (**In production**) without verification keeps grants working; you and up to 100 users see Google's "unverified app" warning when connecting. Opening an app like this to the public requires Google's verification and security assessment.

## Optional settings

All of these go in `server.env`; run `npm run server:deploy` after changing it.

| Setting | Effect |
| :--- | :--- |
| `DOCUMENTS_BUCKET` | Tracked PDFs: per-recipient links and viewing activity. The bucket is created private if missing. |
| `TRACKER_QUEUE=true` | Pixel and click events go through a Cloudflare Queue, so a slow database never delays a recipient's mail client. |
| `WORKERS_PAID=true` | Raises the Workers' CPU and subrequest limits. Needs Cloudflare's Workers Paid plan. |
| `HYPERDRIVE_ID` | Database connections through Cloudflare Hyperdrive (point it at the Supabase **session** pooler, port 5432, caching disabled). |
| `API_URL`, `TRACKER_URL` | Custom domains you've routed to the Workers, instead of `workers.dev`. |
| `CLOUD_AI_DAILY_REQUEST_LIMIT` | AI requests per account per day (default 500). |
| `CLOUD_AI_RATE_LIMIT_PER_MINUTE` | AI requests per account per minute (default 30). |
| `CLOUD_AI_GLOBAL_DAILY_TOKEN_BUDGET` | AI tokens per day across the server (default 50 million). |
| `CLOUD_AI_MONTHLY_BUDGET_MICROS` | Per-account monthly AI budget in micro-dollars, priced by the `CLOUD_AI_*_COST_PER_1K_MICROS` settings. Off by default. |
| `CLOUD_AI_PROVIDER=cloudflare` | Send AI requests through Cloudflare AI Gateway (`CLOUD_AI_BASE_URL` is then the gateway's compat URL; `CLOUD_AI_GATEWAY_TOKEN` if your gateway requires one). |
| `WEB_SEARCH_PROVIDER=brave`, `WEB_SEARCH_API_KEY` | Lets Ask look things up on the web. |
| `SEQUENCES_ENABLED=true` | Personalized follow-up sequences. Every batch still needs your approval. |
| `EXTRA_EXTENSION_IDS` | More extension IDs allowed to sign in (another browser or computer). |

## Updating

```bash
git pull
npm install
npm run server:deploy
```

Deploying applies new migrations, redeploys both Workers and rebuilds the extension. Reload PigeonBox in `chrome://extensions` afterwards.

## Backups and secrets

- `.local/server-secrets.json` holds the key that encrypts stored mail data, Google credentials and drafts. Keep an offline copy. To rotate it, see [server operations](server/operations.md).
- `server.env` holds your Supabase service key and AI key. It never leaves your computer except as Worker secrets.
- Supabase backs up the database on its own schedule; see your project's **Database → Backups**.

## Run a server on your computer

For development, run the server locally with mock AI, a development sign-in page and an in-memory store. No accounts needed.

```bash
cp workers/api/.dev.vars.example workers/api/.dev.vars          # set DEV_AUTH_SECRET; add your extension ID
cp workers/api/.dev.vars workers/server-tracker/.dev.vars
npm run server:dev            # API and dashboard on http://127.0.0.1:8788
npm run server:dev:tracker    # tracker on http://127.0.0.1:8789
```

Then build the extension against it: put `VITE_PIGEONBOX_CLOUD_API_URL=http://127.0.0.1:8788` and `VITE_PIGEONBOX_CLOUD_TRACKER_URL=http://127.0.0.1:8789` in `apps/extension/.env.local` and run `npm run build`. More in [server development](server/development.md).

## Troubleshooting

| Symptom | Check |
| :--- | :--- |
| Deploy says it can't read your `workers.dev` address | Run `npx wrangler deploy` once in any project to register a `workers.dev` subdomain, or set `API_URL` and `TRACKER_URL`. |
| Sign-in returns to the wrong page or loops | Supabase **Redirect URLs** must include `https://<extension-id>.chromiumapp.org/**` and `https://pigeonbox-api.<subdomain>.workers.dev/**`. The extension ID is in `.local/server.json`. |
| "This account is not allowed on this PigeonBox server" | Add the address to `ALLOWED_EMAILS` and deploy again. |
| "That redirect address is not allowed" | The extension's ID isn't allowed. Deploy again after loading the rebuilt extension, or add its ID to `EXTRA_EXTENSION_IDS`. |
| A feature says the server isn't configured for it | The capability needs settings you haven't set. Always-on features need the Pub/Sub settings; tracked PDFs need `DOCUMENTS_BUCKET`. |
| Sessions are rejected as invalid tokens | Older Supabase projects sign sessions with the legacy JWT secret: set `SUPABASE_JWT_SECRET`. |
| Gmail stops syncing after a week | Your OAuth consent screen is in Testing. See [Google's limits](#always-on-gmail). |
| Anything else | `npm run server:smoke`, then the Worker logs: `npx wrangler tail pigeonbox-api`. [Server operations](server/operations.md) has a runbook. |

## Minimal alternatives

If you only want tracking and would rather not run the full server:

- [Convex tracker](convex-self-hosting.md): one command, free tier.
- [Cloudflare Worker + Supabase tracker](tracker-cloudflare.md): a single-user tracker with a personal token.
