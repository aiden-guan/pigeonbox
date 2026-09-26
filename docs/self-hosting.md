# Self-hosting

PigeonBox's inbox features and local AI run in your browser. Open/click tracking is optional and uses a separate service. To count a recipient open, the tracking pixel in the email must point to a public HTTPS endpoint that their mail client can reach. A `127.0.0.1` tracker is reachable only from the computer running it.

| Option | Persistence | Accounts needed | Guide |
|---|---|---|---|
| **Convex** | Convex database | Convex | [convex-self-hosting.md](convex-self-hosting.md) |
| **Cloudflare Worker + Supabase** | Supabase Postgres | Cloudflare, Supabase | Below |
| Cloudflare Worker without Supabase | Memory per Worker isolate (not durable) | Cloudflare | Testing only |
| `npm run tracker` on this computer | Memory by default; only reachable from this machine | None | [local-setup.md](local-setup.md) — development only |

Supabase is the durable database for the Cloudflare Worker option; it does not provide the public tracking HTTP endpoint by itself. Choose Convex for a single-provider setup, or Cloudflare Worker + Supabase for a separate endpoint and database.

Every self-hosted tracker is **single-owner**: one `PERSONAL_API_TOKEN` protects its management API. Pixel (`/open/:id`) and click (`/c/:id`) routes are public by design. Tracking IDs are random and carry no mailbox data.

## Cloudflare Worker + Supabase

### 1. Supabase

Create a project and apply the migrations in `supabase/migrations/` in order (SQL editor or `supabase db push`). They create `tracked_emails`, `tracked_links`, `tracking_events` and `tracking_self_view_claims` with RLS enabled and no client policies; only the Worker's service role reads or writes them.

### 2. Worker

```bash
cd workers/tracker
npx wrangler login
npx wrangler secret put PERSONAL_API_TOKEN          # the token from your .env
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # stays on the Worker, never in the extension
npx wrangler deploy
```

The Worker name in `wrangler.toml` is `gi-tracker`. It is kept from before the PigeonBox rename because renaming it deploys a different `*.workers.dev` URL, and pixels in mail you already sent point at the old one.

### 3. Connect PigeonBox

Settings → Email tracking → paste the Worker URL and the same token → **Save**. Chrome asks for permission to reach that host. The status line should read **Tracker healthy**.

### Updating

Redeploy after pulling changes to `workers/tracker` and apply new migrations. Settings shows "Tracker deployment is outdated" when the tracker lacks a protocol feature the extension needs.

## What the tracker stores

Per tracked email: subject, sender, recipients, Gmail thread/message IDs, sent time, open/click counts. Per event: time, user agent, a salted hash of the IP (never the raw IP), classification. Link destinations for rewritten links. Mailbox bodies are never sent to the tracker.

## Disconnecting

Clear the URL and token in Settings → Email tracking (or turn tracking off) and save. Delete the Worker and Supabase project to remove stored data.
