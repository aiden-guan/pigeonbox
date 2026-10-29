# Contributing to PigeonBox

Thanks for helping. PigeonBox is a Chrome extension that works inside Gmail; this repository contains everything needed to build it, run it locally, and self-host its optional server and standalone tracker.

## Setup

Node.js 24.15+ (see `.nvmrc`).

```bash
npm run setup
npm run dev          # rebuild on change, then Reload on chrome://extensions
npm run dev:reload   # or: Settings → "Reload extension" rebuilds, then reloads
npm run dev:reload:install  # macOS: keep that helper running in the background
npm run verify       # what CI runs
```

No deployed server, Supabase, Cloudflare, Convex, or AI key is needed to develop. Server tests run against an in-process WASM Postgres, and `npm run server:dev` runs the server locally with mock AI ([docs/server/development.md](docs/server/development.md)).

## Principles

- **No Gmail REST API in the extension**, no private Gmail endpoints, no cookie scraping. Extension writes go through Gmail's UI via `packages/gmail`. Only the optional server uses the Gmail API, after the person connects Google.
- **Selectors live in `packages/gmail/src/selectors.ts`.** Application code does not know DOM details.
- **Never send email automatically.** PigeonBox drafts, inserts and suggests; sending, deleting, spam and unsubscribe always need the user (safety tier 3).
- **Local stays a real product.** Do not gate local features behind a server.
- **Branch on capabilities, not modes.** Use `has('…')` from `ui/product-state.ts`; add capabilities to `@pigeonbox/api-contract` only when something implements them.
- **Server mode never falls back** to another AI provider, and PigeonBox never changes the user's run mode on its own.
- **Secrets stay in the service worker.** Content scripts get public settings only. Nothing secret goes in `VITE_*` variables.
- **Preserve stored names.** IndexedDB names, `chrome.storage` keys and tracking protocol identifiers are persistent. Changing one needs a migration and a test.
- **Tracking is high risk.** Changes to open/click classification must keep the regression matrices in `packages/tracking`, `workers/tracker` and `convex` passing and consistent.
- **The extension never imports server code.** The server (`@pigeonbox/server`) is reached over HTTPS through `@pigeonbox/api-contract`; `npm run check:repo` enforces this. Code calls server mode `cloud`; user-facing text says "your PigeonBox server".
- **Server safety stays on.** Never log email content, keep every user-owned table under RLS, and keep capabilities tied to what the server is configured to serve (`servedCapabilities`).

## Packages

All packages use the `@pigeonbox/*` namespace. See [docs/architecture.md](docs/architecture.md).

## Pull requests

- Small and focused, with tests for logic you change.
- `npm run verify` passes.
- No secrets, `.env` files, or real mailbox data in code, tests, or screenshots.
- Changing the extension–server contract: additive changes only unless you bump `PROTOCOL_VERSION`; see [docs/cloud-protocol.md](docs/cloud-protocol.md).
- Changing the server schema: add a new migration in `supabase/migrations/` rather than editing an existing one (deployments record applied versions and do not rerun them); `migrations.test.ts` checks RLS and ownership rules.

## InboxSDK

The extension ships with a registered InboxSDK app ID. Forks distributing their own build should register their own at InboxSDK and set it in Settings → Advanced.
