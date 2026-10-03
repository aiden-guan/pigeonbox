# Recommended: self-host email tracking on Convex

Convex is the default public tracker for the guided source install. It provides the HTTPS tracking endpoint and durable database in one service. Your tracker runs in your Convex account; PigeonBox does not host a shared tracker.

## Set it up

From the repository root, after cloning:

```bash
npm run setup -- --tracking --open
```

If the extension was already installed, run:

```bash
npm run setup:tracker -- --open
```

The setup requires explicit approval before signing in to Convex or creating/updating cloud resources. Direct interactive runs ask in the terminal; an agent that already received approval uses `--yes`. It uses the Convex CLI to create or select a project, configure its production deployment, deploy this repository's `convex/` functions, set the personal tracker token as a production secret, and check that the public `/health` route reports protocol version 3. It then stores the tracker URL and token in ignored local files, rebuilds the extension, and opens `chrome://extensions`.

The local extension build is prefilled with the tracker. After loading it in Chrome, open **Settings → Email tracking**, click **Save**, and approve Chrome's request to access the Convex endpoint. Confirm the status says **Tracker healthy**. Chrome requires this user action before an extension can contact a new host.

The CLI and deployment flow are documented in [Convex CLI](https://docs.convex.dev/cli) and [HTTP Actions](https://docs.convex.dev/functions/http-actions). Convex account limits and terms apply.

## What it stores

Tables in `convex/schema.ts`:

| Table | Contents |
|---|---|
| `trackedEmails` | Tracking ID, subject, sender, recipients, Gmail thread/message IDs, status, sent time, open/click counts |
| `trackedLinks` | Click ID → destination URL for rewritten links |
| `trackingEvents` | OPEN / CLICK / SELF_VIEW events: time, user agent, salted IP hash, classification |
| `selfViewClaims` | Short-lived sender self-view claims used to ignore your own opens |

No mailbox bodies, drafts, summaries, or AI data are stored. Every Convex function is internal; the only entry points are the HTTP actions in `convex/http.ts`: public `/open/:id`, `/c/:id`, `/health`, and `/api/*` routes that require `Authorization: Bearer <PERSONAL_API_TOKEN>`.

## Manual deployment

The setup helper is the recommended route because it safely transfers the local token to the production environment, health-checks the deployed endpoint, and pre-fills the extension. If you deploy manually, follow Convex's CLI instructions for your account and set `PERSONAL_API_TOKEN` as a production environment variable without placing the token in shell arguments or logs. Then use the deployment's HTTP actions URL in **Settings → Email tracking**, save, and confirm **Tracker healthy**.

Self-hosting the open-source Convex backend is also supported. Point the Convex CLI at your deployment as described in Convex's self-hosting documentation and use that deployment's HTTP actions URL.

## Disconnect and local files

Clear the tracker URL and token in Settings and save to disconnect. To delete data, clear the tables in the Convex dashboard or delete the deployment.

| Where | Name | Purpose |
|---|---|---|
| Convex production deployment | `PERSONAL_API_TOKEN` | Management API token; also salts IP hashes |
| `.env.local` (written by the CLI) | `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` | Convex project selection and local CLI state |
| `.local/convex-tracker.env` | `PERSONAL_API_TOKEN` | Private local file used to set the production secret |
| `apps/extension/public/tracker-config.json` | Tracker URL and token | Ignored machine-local config copied into the local extension build; excluded from release builds |

Convex configuration is separate from, and never merged into, PigeonBox Cloud configuration.

## Chrome extension CORS

The tracker answers token-free `OPTIONS /api/*` preflights from valid `chrome-extension://` origins. API responses, including authentication and validation errors, allow that same extension origin. Other browser origins are not allowed. Actual API requests still require the personal bearer token; cookies are not used. Unpacked extension IDs can change, so the tracker validates the Chrome extension origin format rather than hardcoding one installation.

If Chrome reports a preflight response without `Access-Control-Allow-Origin`, update the existing tracker deployment with this repository's `convex/` code. A folder rename or extension rebuild alone does not update the hosted tracker.
