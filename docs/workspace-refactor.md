# Unified PigeonBox workspace

Implementation and verification record for the October 2, 2026 refactor. Both repositories retain their ownership boundary: the public repository owns Gmail, the extension and Local execution; the private repository owns hosted services, account administration and billing. These changes are working-tree changes. Production deployment and Chrome Web Store publication are separate release steps.

## 1. Architecture

`PigeonBoxWorkspace` is the canonical application. A persistent Gmail shadow host supplies position, size, collapse and keyboard controls; its trusted extension iframe renders the application. `SidePanelApp` is a thin wrapper around that same component for optional native docking. The background worker remains the only authority for settings, Cloud credentials, inference, tracking and mailbox persistence.

Top-level navigation is Home, Inbox and Ask. Home shows actionable work and the current Gmail conversation. Inbox uses one category selector. Ask inherits the current conversation and supports existing mailbox retrieval when the capability is present. Prepared replies, commitments, follow-ups and tracking appear in context. Approvals, activity, memory, connections and other existing features remain discoverable through command search and Settings. UI gating uses capabilities rather than plan names.

The hosted web application starts with account overview, billing, connected accounts, privacy, workspace/team, API/MCP and audit controls. Its advanced workflow controls remain under progressive disclosure. Daily prepared work and conversation actions live in the Gmail workspace.

## 2. Changed files by subsystem

Paths below are relative to the respective repository; directories identify related changed entry points, tests and styles.

| Subsystem | Public repository | Private repository |
| --- | --- | --- |
| Workspace and display | `apps/extension/src/workspace/{PigeonBoxWorkspace,CurrentThread,Tasks,Commands,display,session,state,context,thread-question}`, `content/shell/{workspace,float-drag,surface}`, `background/workspace`, `SidePanelApp`, toolbar/manifest/Vite/package entries | `apps/web/public/{app.html,control/main.js,control/sections/overview.js,control/control.css,control/product-tokens.css}` |
| Owner identity and inference | `packages/shared/src/owner`, `packages/ai/src/{index,summary-prompt,compact-prompts,prompt-provider,draft-prompt}`, `packages/agent/src/index`, `packages/mailbox/src/{types,index}`, `content/gmail-owner`, `background/{mailbox-identity,owner,index}`, additive AI contract fields | `packages/server/src/intel/{analyze,prompts,thread-summary,threads}`, synchronized shared/AI vendors |
| Settled tracking | `packages/tracking/src/{attribution,lifecycle,index}`, `content/tracking/{message-self-view,dom-self-view}`, `background/tracking/{tracked-mail,notifications}`, background navigation/claim/poll routing, `workers/tracker/src/{index,helpers}`, `convex/{http,openRequest,tracking}` | `packages/server/src/tracker-supabase.test.ts`, synchronized tracker/tracking vendors |
| Tasks and contextual Ask | `packages/api-contract/src/{tasks,research,routes,index}`, `background/cloud/page-calls`, `workspace/{Tasks,thread-question}`, `sidepanel/CloudAsk`, account-bound local Ask routing | `packages/server/src/intel/{tasks,research}`, `packages/server/src/routes/features`, `intel/workspace.test.ts` |
| Integrated feature UI and design | `content/thread/{ThreadPanel,CloudCompanion}`, `sidepanel/{CloudView,CloudHome,CloudDrafts,DraftReview,DraftsView,WaitingView}`, `settings`, `onboarding`, shared `ui` primitives/tokens/motion/appearance/continuity, preview entry points and styles | Account site hierarchy and semantic product tokens |
| Gmail lifecycle, compatibility and cleanup | `packages/gmail/src/DomFallbackAdapter`, content wiring, message allowlists, deleted `src/popup/*` and old content command palette, dev reload/package scripts, architecture/local setup/store/dispatch docs | Hash-checked `vendor/PUBLIC_SOURCE.json` and generated vendor files |
| Verification | Identity/perspective/agent/attribution/notification/Gmail/workspace/component tests, browser fixtures and workspace/tracking/design tests | Hosted owner/task/source-isolation tests, tracker regressions, updated account-site browser tests |

## 3. Tracking race fix

The visible state is a settled snapshot, rather than an unqualified copy of eventually consistent server counters.

1. Before asynchronous navigation work, the worker reserves attribution for precisely the known tracked messages in the loading Gmail thread. A content self-view claim likewise creates its reservation at runtime-message entry, before settings or network work. Reservations include tracker issuer, tracking ID, event ID, observation time and tab/navigation identity. They are not mailbox-wide suppression windows.
2. The InboxSDK and DOM paths use the same self-view controller. Known pixels, including quoted pixels, are reserved before asynchronous Gmail ID discovery. A loading DOM thread does not report a completed inspection before messages exist.
3. While a claim is unresolved, polling retains that message's last settled counters and timestamps. New events subject to attribution are excluded from the visible timeline and notification delivery. Already settled history and unrelated tracked messages remain usable. The opened animation therefore never receives the provisional increment.
4. A canonical self-view response invalidates older poll revisions, records `reclassifiedEventIds`, and writes the authoritative `open_count`, timestamps and related counters through the serialized tracked-mail writer. Only after that write does the claim settle. Idempotent retries return the same canonical classification information. Old endpoints can be reconciled through an authoritative detail fetch.
5. A failed request remains pending with retry metadata in trusted session storage. An in-flight claim is not retried concurrently by ordinary polling. There is no timer that declares an event settled. Once attribution settles, immediate legitimate recipient events can be published and notified normally.

Worker, Convex and shared lifecycle logic retain sender one-shot claims, the existing narrow Google proxy burst handling, quoted render claims, scanners/machine events and browser recipient events. Reclassification recomputes counters. The change does not extend a broad time window to hide all opens.

## 4. Owner-identity race fix

The owner is mandatory data for Gmail perspective-sensitive generation. Gmail account detection uses the signed-in account, not an unrelated visible contact. The background identity store scopes owners to account slots and tabs. Explicit self labels teach send-as aliases; refreshes retain those aliases only for the same owner. A different account in the same slot does not inherit them. Gmail address normalization and existing explicit alias support remain available; real third-party addresses are not guessed from a matching name.

Messages are tagged with `authorRole: owner | other` before inference. Provider inputs serialize owner-authored messages as from you. Owner email, name, aliases and a perspective version participate in cache/in-flight identity. Loading identity produces a neutral resolving state. Ownerless and differently scoped summaries are hidden from thread intelligence and Inbox snippets.

Local generation uses per-thread generation IDs and serialized writes shared across agent instances using the same mailbox. An older job cannot overwrite a newer owner-aware result. Hosted analysis includes an owner version in its fingerprint and uses a locked content-version check before saving summaries or generating downstream commitments/drafts.

A post-generation check rejects third-person actor attribution to the known owner before publication or persistence. It repairs once through the provider and falls back to neutral/extractive information if necessary. It does not replace every name occurrence: quoted bodies, third-party mentions and same-name contacts remain intact. Hosted legacy ownerless summaries stay neutral until regenerated.

## 5. Workspace lifecycle and state

`workspaceState` in trusted local storage holds Home/Inbox/Ask, category, secondary section, display mode, open state, position and size. Legacy panel navigation migrates safely; invalid geometry and obsolete Cloud navigation normalize to valid values. Existing settings, mailbox database, tracking records and protocol identifiers remain intact.

The Gmail host survives route changes, observes viewport bounds, and reuses the existing drag/resize implementation. The header supports arrow-key movement, Shift+arrow resizing and Home reset. Collapse retains the host and Pidgy; reopening restores geometry and navigation. Focus returns to the launcher or underlying Gmail as appropriate. Hidden shells are inert.

Toolbar clicks collapse/reopen the active Gmail workspace, focus an appropriate existing Gmail tab, or open Gmail and queue reopening until integration is ready. Native docking is requested directly in a user click to satisfy Chrome's gesture requirement. Only the active display shell mounts feature content. Unfinished Ask and draft edits/review identifiers survive transfer through account-scoped, expiring trusted session storage; draft review data is fetched again rather than stored permanently in presentation state.

The workspace shell opens without waiting for inference, tracking or hosted sync. Current-thread state is keyed by thread and owner to prevent an old account/conversation paint. Existing Cloud request caches remain in use. DOM fallback observers ignore PigeonBox's own UI mutations, observe Gmail hash changes, and detach when stopped.

## 6. Consolidated and removed UI

- Removed the toolbar popup implementation, its build entry and `default_popup`. The toolbar acts on the canonical workspace.
- Replaced side-panel application duplication with a wrapper around the shared workspace.
- Removed the old isolated floating thread shell, island mode controls, shadow command palette and obsolete preview/styles. Thread content now renders within the workspace.
- Removed Cloud as a permanent navigation destination and generic Open Gmail controls from normal in-Gmail surfaces. Specific source/thread/draft navigation remains.
- Consolidated Home into actionable work, reduced Inbox category buttons to one selector, and made command search the secondary feature entry point.
- Grouped settings and privacy/execution copy, removed duplicate configuration/reset controls, and shortened onboarding around Local versus Cloud execution.

Local inference, BYOK, tracking, Ask, follow-ups, prepared drafts, approvals, memory, authentication, billing, sync and capability gates remain. Saved tasks use the existing encrypted hosted task table: suggestions require explicit Save, completion/reopening is explicit, and source email/account and due dates remain attached.

Motion communicates expansion/collapse, navigation/context, preparation, completion and focus. It is short and interruptible, honors reduced motion/transparency, and uses Pidgy as a small state indicator. Semantic themes, compact widths and focus behavior have browser coverage.

## 7. Regression coverage

- Tracking: claim-before-proxy and proxy-before-claim, reloads, duplicate proxy burst, quoted pixels, legitimate immediate recipient opens, scanner/headless events, canonical counter restoration, stale poll revisions, pending timeline filtering and notification suppression.
- Real extension race fixture: hold the self-view endpoint while the synthetic tracker has already counted the reload proxy; observe every tracked-mail storage write, cached count, visible timeline, notification history and desktop alerts; release reconciliation; then require an immediate legitimate recipient open to publish and alert.
- Identity: owner newest/earlier messages, another newest sender, aliases and explicit self labels, late/unknown identity, changed cache perspective, stale jobs, multiple account slots, same-name contacts, quoted mentions and Local/hosted provider repair.
- Workspace: toolbar active/other/no Gmail tab, migration and geometry, keyboard movement/resize, viewport bounds, collapse/reopen, route changes, actual dock gesture, input transfer, command search/focus, current-context Ask, source-linked task save/complete, missing capabilities and themes/reduced motion.
- Hosted services: encrypted idempotent task creation, source/account ownership, cross-user task/Ask refusal, completion/reopen, legacy summary neutrality, repaired summary and stale-analysis side-effect rejection. Existing contract/server/tracker tests continue to run.

## 8. Verification results

Results are recorded against these working trees and synthetic fixtures, not live mailbox activity.

| Check | Result |
| --- | --- |
| Public `npm run verify` | Passed: repository/version/dependency checks, typecheck, lint, 76 test files / 692 tests, all builds, release ZIP validation |
| Public `npm run test:browser` | Passed: all 34 Chromium tests, including held self-view reconciliation, immediate recipient notification, native docking, context/source-linked tasks, motion/interruption, reduced motion, compact themes and idle performance |
| Public `npm run package` | Passed: `release/PigeonBox-v0.4.0.zip`, 56 files / 8.4 MB; MV3, no popup, shared workspace and optional side-panel entries, no browser-test fixture in the ZIP |
| Private `npm run acceptance`: vendor/secrets/typecheck/server/contract checks | Passed: 31 test files / 282 tests; hash-checked vendors match the edited public source |
| Private `npm run acceptance`: browser and bundles | Passed: 10 account-site Chromium tests and production-config dry-run bundles for both API and tracker Workers |

Release ZIP SHA-256: `b80bea73c6b49e3a5120e2d17230427841f72e92a697f238e99c553a7ad0ed32`.

The Gmail content script receives appearance as sanitized presentation metadata over the allowlisted worker bridge. It does not gain access to trusted storage. This has a dedicated regression test. Renderer-level motion tests observe real Chrome animations, including the isolated content-script world; they do not assume a short animation is still running after a test protocol round-trip.

No production deploy, migration, live billing change, push or Web Store publication was performed.

## 9. Practical limits

Chrome's native side-panel APIs require an explicit user gesture and vary by browser version. Optional close events/APIs are feature-detected; toolbar reopening and floating controls remain available. See [Chrome sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

Tracking remains probabilistic about recipients, image proxies and scanners. This refactor settles known self attribution before exposing it; it cannot establish which human loaded a proxied image. If the tracker is unreachable, affected claims remain pending at the last settled state until a canonical retry succeeds. No arbitrary delay fabricates a resolved fact.

Fixture tests validate extension/runtime and hosted behavior, but cannot replace installed-extension verification against live Gmail/InboxSDK, real Google accounts, an actual recipient and the user's selected AI provider. The native panel's external close behavior on older supported Chrome versions also needs installed-browser QA. These are release validation steps.

## 10. Manual QA before release

1. Load the release ZIP in a clean Chrome profile, finish Local onboarding, and confirm Gmail opens with the workspace. Confirm Settings and existing preferences/data still work after updating an existing install.
2. Exercise toolbar clicks with an open, collapsed and absent Gmail tab. Move and resize with pointer and keyboard; reopen, reload Gmail, change routes, shrink the viewport and switch reduced motion/themes. Verify focus restoration and Gmail/compose keyboard shortcuts.
3. Type an unfinished Ask question and edit a prepared reply. Dock using the workspace button, return to Float, close the native panel externally and reopen from the toolbar. Verify one active application and retained inputs.
4. Use two signed-in Gmail accounts and a send-as alias. Open owner-sent and recipient-sent threads; delay identity/AI responses and navigate away/back. Confirm neutral loading, second-person summaries and no stale account/job results.
5. Track a genuinely sent email. Reload it repeatedly, expand/collapse its messages and quoted messages, and interrupt tracker connectivity. Watch count, opened animation, activity and notifications. Have an actual recipient open immediately afterward; verify the settled open and notification appear once.
6. In Local mode, verify Ask/current-thread summary, draft insertion, inbox categories, follow-ups, tracking and source navigation. Test the selected real Local/BYOK provider.
7. In Cloud mode, verify capabilities, connection/sync, Home/prepared replies, approvals/placeholders, follow-ups, memory, current-thread and mailbox Ask. Disconnect or remove capabilities and verify clear, accurate states without implicit provider fallback.
8. Save a suggested commitment/follow-up as a task, create one manually, complete/reopen it and navigate to its email source. Verify suggestions remain suggestions until explicitly saved.
9. Verify the hosted account site: billing, connected accounts, privacy/retention, team, API/MCP and audit plus advanced workflow controls. Test sign-out/expiry and narrow layouts.
10. Complete Chrome Web Store permission/privacy/listing review and coordinated client/server release verification before publishing. Existing test-mode billing remains test-mode unless explicitly authorized.
