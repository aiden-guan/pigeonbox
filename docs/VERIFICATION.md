# Manual verification

## Automated

```bash
npm run verify     # repo checks, versions, typecheck, lint, tests, build, release ZIP validation
```

`verify` runs without any Cloud backend, Supabase, Stripe, Convex or AI key. Local-mode independence from Cloud is covered by `packages/core/src/core.test.ts` and `apps/extension/src/background/ai/provider-router.test.ts`; settings migration by `packages/shared/src/settings-migration.test.ts`.

## Live Gmail

This environment did not sign in to Gmail, so the flows below are **not** claimed as verified here. After loading `apps/extension/dist`:

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

- Native Gmail label mutation is not available. Categories are local.
- Ask Pigeon and summaries use full message text only after a thread has been opened. Row snippets are previews.
- Archive is confirmed by Gmail’s notice, leaving the thread, or the thread disappearing from the inbox list. A click alone is not success.
- ChatGPT web sign-in is experimental and not part of setup.
- Tracking cannot delay or block Send. A miss is logged and the mail goes out untracked.
- Future IMAP throws if selected. Gmail web is the only source.

## Tracker worker

```bash
npm run setup
npm run tracker
curl -s http://127.0.0.1:8787/health
```

Expect `{"ok":true,"store":"memory"}`. The Bearer token is `PERSONAL_API_TOKEN` in `workers/tracker/.dev.vars`.

## Local and Cloud (manual)

1. Fresh profile, source build: onboarding offers **On this computer** and **Advanced**; PigeonBox Cloud is listed only when the build has a Cloud URL.
2. Existing 0.1.x profile upgraded to 0.2.0: settings, AI choice, tracker URL/token and index are unchanged, and **How should PigeonBox run?** shows On this computer.
3. If the tracker stops reporting after the upgrade, Settings → Email tracking → Save to re-grant the now-optional host permission.
4. Cloud (with a local `pigeonbox-cloud` in mock mode): choose Cloud, agree, sign in; a summary shows "Analyzing with PigeonBox Cloud…". Stop the Cloud API: summaries fail with "PigeonBox Cloud is unavailable. Nothing was sent to another provider." and categories keep working. **Run on this computer instead** restores Local without losing the Local AI choice.
