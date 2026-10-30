# Verification

## Local presentation pass — 2026-10-19

Publication application source: `c5bd90fc98eda3070e7a624c85fee7ee1168b7f8` (extension 0.8.3). This pass used an isolated checkout of `origin/main`, including its dependency upgrades and settings fix. Three pre-existing local feature commits were left in the original checkout and are excluded from this publication.

| Check | Observed result |
| :--- | :--- |
| Fresh dependency installation | `npm ci` passed using Node 24.22.0 and npm 11.19.1, against the publication checkout's lockfile |
| `npm run verify` | Passed dependency, version, repository hygiene, typecheck, lint, test, build, and release-package validation steps |
| Unit and script tests within verify | 1,133 Vitest tests in 116 files; 15 Node script tests passed |
| Build isolation | Extension output went to an ignored temporary folder in the publication checkout; the original working Chrome build was preserved |
| README capture helper | Passed; five 2× PNGs from the compiled extension with synthetic mail and API responses |
| Focused browser checks | 18 passed across `dispatch.spec.ts`, `cloud-home.spec.ts`, and `workspace.spec.ts` using the isolated build |
| Strict documentation validation | Root README, documentation index, claim map, verification page, and capture guide passed without errors or warnings |
| Historical changelog validation | No errors; three existing warnings also occur in the unchanged baseline (colon-script parsing and release-only environment variables). No warnings introduced |

The captures exposed an existing inbox layout regression at widths of 600 CSS pixels and above: an older grid rule compresses the current list/brief into a narrow column. The feature panels use the 480-pixel layout. Application CSS was not changed. See [capture provenance](../assets/readme/README.md) and the [claim map](presentation.md).

The complete Playwright suite, current remote CI, real Gmail, Google OAuth, live models, recipient activity, and store publication are separate acceptance steps and are not established by this record.

The focused browser run used this command after fixture preparation, with the isolated build supplied as the extension path:

```bash
PIGEONBOX_BROWSER_EXTENSION_PATH=/tmp/pigeonbox-readme-extension npx playwright test tests/browser/dispatch.spec.ts tests/browser/cloud-home.spec.ts tests/browser/workspace.spec.ts
```

## Automated

```bash
npm run verify     # repo checks, versions, typecheck, lint, tests, build, release ZIP validation
```

`verify` runs without a deployed server, Supabase, Cloudflare, Convex or AI key; server tests run against an in-process WASM Postgres (PGlite). Local-mode independence from the server is covered by `packages/core/src/core.test.ts` and `apps/extension/src/background/ai/provider-router.test.ts`; settings migration by `packages/shared/src/settings-migration.test.ts`.

## Live Gmail

This presentation pass did not sign in to Gmail, so the flows below are **not** claimed as live-verified here. After loading `apps/extension/dist`:

1. Open Gmail. Settings → Advanced → Run diagnostics.
   - Gmail tab: connected
   - Active integration: InboxSDK or DOM fallback
   - Last Gmail event has a timestamp and a type such as `VISIBLE_ROWS_CHANGED` or `THREAD_OPENED`
2. Open one thread twice. Diagnostics and the activity log should not show a new classification the second time if the message did not change.
3. Click Respond in the Gmail sidebar or the extension side panel. The list is local threads, not a Gmail search. Opening a row goes to that thread.
4. On a Respond thread, click Draft reply. Gmail’s reply box opens with the draft. The extension does not send it.
5. With two Gmail tabs open, turn on auto-archive only if you intend to test it. The inactive pinned worker tab should move, not the tab you are reading.
6. Tracking acceptance is [docs/tracking-debug.md](tracking-debug.md). Send should feel immediate. If the tracker is down, the message still sends. A sent row stays **Sent** until an OPEN event exists, then **Opened**. Do not treat a tracker record by itself as an open. The raw MIME check in that doc was not run in this environment.

## Honest degradation

- Local categories are local state. Server-side mail organization has separate Google permissions and approval flows; validate those against your deployed server.
- Ask Pigeon and summaries use full message text only after a thread has been opened. Row snippets are previews.
- Archive is confirmed by Gmail’s notice, leaving the thread, or the thread disappearing from the inbox list. A click alone is not success.
- ChatGPT web sign-in is experimental and excluded from release builds.
- Tracking cannot delay or block Send. A miss is logged and the mail goes out untracked.
- Future IMAP throws if selected. Gmail web is the only source.

## Tracker worker

```bash
npm run setup
npm run tracker
curl -s http://127.0.0.1:8787/health
```

Expect `{"ok":true,"store":"memory"}`. The Bearer token is `PERSONAL_API_TOKEN` in `workers/tracker/.dev.vars`.

## Local and server mode (manual)

1. Fresh profile, source build: onboarding offers **On this computer** and **Advanced**; **Your PigeonBox server** is listed only when a server is configured.
2. Existing 0.1.x profile upgraded to 0.2.0: settings, AI choice, tracker URL/token and index are unchanged, and **How should PigeonBox run?** shows On this computer.
3. If the tracker stops reporting after the upgrade, Settings → Email tracking → Save to re-grant the now-optional host permission.
4. Server mode (with `npm run server:dev` in mock mode; see [server/development.md](server/development.md)): choose **Your PigeonBox server**, agree, sign in; summaries come from the mock provider. Stop the server: summaries fail with "Your PigeonBox server is unavailable. Nothing was sent to another provider." and categories keep working. Switching back to **On this computer** restores Local without losing the Local AI choice.
