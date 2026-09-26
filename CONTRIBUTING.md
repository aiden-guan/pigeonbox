# Contributing to PigeonBox

Thanks for helping. PigeonBox is a Chrome extension that works inside Gmail; this repository contains everything needed to build it, run it locally, and self-host its optional tracker.

## Setup

Node.js 20+ (see `.nvmrc`).

```bash
npm run setup
npm run dev          # rebuild on change, then Reload on chrome://extensions
npm run dev:reload   # or: popup → "Reload extension" rebuilds, then reloads
npm run verify       # what CI runs
```

No Cloud backend, Supabase, Stripe, Convex, or AI key is needed to develop.

## Principles

- **No Gmail REST API**, no private Gmail endpoints, no cookie scraping. Writes go through Gmail's UI via `packages/gmail`.
- **Selectors live in `packages/gmail/src/selectors.ts`.** Application code does not know DOM details.
- **Never send email automatically.** PigeonBox drafts, inserts and suggests; sending, deleting, spam and unsubscribe always need the user (safety tier 3).
- **Local stays a real product.** Do not gate local features to promote Cloud.
- **Branch on capabilities, not modes or plans.** Use `has('…')` from `ui/product-state.ts`; add capabilities to `@pigeonbox/api-contract` only when something implements them.
- **Cloud never falls back** to another AI provider, and PigeonBox never changes the user's run mode on its own.
- **Secrets stay in the service worker.** Content scripts get public settings only. Nothing secret goes in `VITE_*` variables.
- **Preserve stored names.** IndexedDB names, `chrome.storage` keys and tracking protocol identifiers are persistent. Changing one needs a migration and a test.
- **Tracking is high risk.** Changes to open/click classification must keep the regression matrices in `packages/tracking`, `workers/tracker` and `convex` passing and consistent.
- **The public repository never imports PigeonBox Cloud code.** Cloud is reached over HTTP through `@pigeonbox/api-contract`; `npm run check:repo` enforces this.

## Packages

All packages use the `@pigeonbox/*` namespace. See [docs/architecture.md](docs/architecture.md).

## Pull requests

- Small and focused, with tests for logic you change.
- `npm run verify` passes.
- No secrets, `.env` files, or real mailbox data in code, tests, or screenshots.
- Changing the Cloud contract: additive changes only unless you bump `PROTOCOL_VERSION`; see [docs/cloud-protocol.md](docs/cloud-protocol.md).

## InboxSDK

The extension ships with a registered InboxSDK app ID. Forks distributing their own build should register their own at InboxSDK and set it in Settings → Advanced.
