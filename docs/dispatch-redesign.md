# PigeonBox Dispatch redesign

Implemented locally on October 1, 2026. No commit, push, deployment, account change, or backend migration was performed.

## Audit and architecture

The extension has four React page entrypoints (popup, side panel, Settings, onboarding). They share `styles.css`, Pidgy sprites and product state, while the old popup defined an independent palette and the Gmail companion used an isolated shadow stylesheet. Cloud capability checks and transport already exist; the redesign reuses them. Settings contained inherited Memory work, which is preserved.

The local mail API already exposes `LIST_SPLIT`, including sender, subject, snippet and actual counts; `GET_THREAD_INTEL` exposes summary provenance, generation status, actions and dates. The redesign reads those records. The popup shows two preview rows per category. Follow-ups can overlap Waiting because that is how the existing product filters them. Unavailable counts and intelligence are omitted or explained, without sample mail in the shipped UI.

The popup remains explicitly 448px wide with a 320px minimum and a 700px maximum height. Its existing comments about Chrome initially measuring a 320px viewport and viewport-relative heights are preserved. The side panel keeps its independently resizable width. No 100vw popup sizing was introduced.

The old visual systems duplicated peach accents, olive-black backgrounds, 12–28px radii, gradients and glass effects. The new canonical system lives in `ui/product-tokens.css`, using the adjacent website's `dispatch.css` and `home.css` as its visual foundation. Online references checked: [Claude](https://claude.dev/), [shadcn/ui](https://ui.shadcn.com/), and [Mobbin](https://mobbin.com/). The web reader could not load [usepigeonbox.com](https://usepigeonbox.com/); its local source was inspected directly. Existing pixel Pidgy assets are reused; new raster artwork would not serve this brief.

## Surfaces and hierarchy

- Popup: compact identity/health header; 48px command launcher; serif confirmed index count; Respond, Waiting, FYI and Follow-ups; real preview rows; restrained Gmail connection row; four numbered utility rows; mono infrastructure footer.
- Side panel: command launcher, workspace navigation, editorial heading, mail rows and inline briefs. Categories become a vertical rail at 600px and remain horizontally scrollable at narrow widths. Waiting keeps its tracking filters and timeline.
- Ask Pigeon: labeled answer, serif intelligence, visible coverage limits and existing account-bound sources; no message bubbles or simulated token streaming.
- Cloud: the same ink/copper visual language, list-based tools, compact approvals and existing capability gates.
- Settings: desktop navigation rail, active anchor state, divided preference sections and a sticky Save row; compact horizontal navigation on narrow windows. Memory, privacy, provider and account controls are preserved.
- Onboarding: five-step progress, editorial titles, directional reveals and a shared title origin; the existing provider choice and consent workflow is preserved.
- Gmail: isolated compact thread brief, serif summary, rules, compact actions and one shadow for the floating surface. Drag, resize, draft insertion and Cloud context remain intact.

## Tokens and motion

Canonical colors: ink #111214, surfaces #191b1e/#24272b, paper #f3f0e8, copper #a8502c/#e07a52 and pigeon #7d8b9b. Serif is reserved for intelligence, editorial headings and significant counts; sans for controls; mono for status, timestamps and shortcuts. Standard radii are 3/5/6/8px. Old `--gi-*` names remain aliases to avoid breaking component boundaries.

The motion vocabulary uses cubic-bezier(.22,1,.36,1) and cubic-bezier(.2,.7,.2,1), CSS and the Web Animations API. No motion dependency was added.

- Launcher → commands: the palette starts at the launcher's exact bounds. A 300ms clip reveal expands it downwards; rows enter at 20ms intervals. Background content moves 6px and dims to 60%. Escape reverses the reveal over 220ms. A shared selection surface travels between command rows.
- Category navigation: the copper underline retains its identity and moves to the chosen category. Stable thread IDs drive FLIP movement, short spatial exit ghosts and staggered arrivals; the entire list is not crossfaded. Nested sender/subject transforms subtract parent movement. Interrupted motion is cancelled using its current visible geometry.
- Thread → brief: the selected row retains its sender/subject nodes. Neighbors leave; the row expands, intelligence reveals underneath, actions arrive afterward. Back and Escape restore the row and its focus.
- Confirmed counts roll when updated. The popup refreshes on actual storage/index/connection events. A confirmed increase triggers one short Pidgy acknowledgement and routing stroke.
- Local/Cloud: the active mode indicator travels between the actual mode choices; Cloud controls reveal using the existing consent and capability state.
- Onboarding: shared title movement and a directional 300ms reveal follow the actual step.
- Generated results use clip/opacity/3px reveal, with 25ms stagger for claims. There is no artificial token stream or progress percentage.
- Loading uses an animated dispatch route instead of the former shaded orb. Labels describe actual worker activity.

Pidgy is static at idle/offline/attention. Active work uses existing indexing/searching/drafting sprites. The side panel uses working, attention and success according to request/draft state. Success acknowledges once over 550–650ms. No idle hovering, breathing or cursor reactions are added. Routing strokes draw briefly and fade; they do not remain as decorative lines.

Reduced motion disables spatial FLIP, command geometry, sprite loops and step motion. All information and controls stay available.

## Keyboard and accessibility

Popup I/A/T/S routes to Inbox, commands, Tracking and Settings. Shortcuts ignore inputs, textareas, selects and editable content. Cmd/Ctrl+K retains command behavior. The command surface has dialog/combobox/listbox semantics, visible focus, arrow navigation, Enter, a reachable close button, a focus loop and focus restoration. Thread briefs expose expansion state, focus Back on entry, support Escape and restore focus to their source row. Dimmed page content is inert while commands are open; exit ghosts are inert and aria-hidden. Preference navigation exposes its current location. Existing switches, confirmation and permission boundaries are preserved.

## Validation

Status and evidence are updated after the final browser run below. All browser data, Cloud sessions and Gmail pages are synthetic, in disposable profiles. Browser checks exercise the real built MV3 worker and existing UI transport. They do not establish live Gmail account behavior or real local-model performance.

Commands used:

- `rtk npm test`
- `rtk npm run verify` (dependency, version, repository hygiene, typecheck, lint, unit tests, all builds and release ZIP validation)
- `rtk npm run build -w @pigeonbox/extension`
- `rtk npm run lint`
- `rtk npm run test:browser` with `PIGEONBOX_MOTION_QA=1` and an isolated `PIGEONBOX_BROWSER_EXTENSION_PATH`
- `rtk git diff --check`

An optional browser fixture path was added so a concurrent rebuild of `dist` cannot invalidate a test run. Recording is opt-in. Captures live under `test-results`; the disposable profile and fixture server are removed afterward.

Responsive cases: popup 320/360/380/448; side panel 320/400/480/640; Settings 1280 and 360; Gmail companion 1280 and 760. Tested zero and 347+ indexed fixture threads, Local, Cloud, connected/disconnected Gmail, command focus, category changes, brief/back, local and Cloud Ask, consented mode changes, Settings anchors, onboarding, reduced motion, tracking, compose insertion, permissions and SPA lifecycle.

## Files changed by this redesign

Paths below are relative to the EmailApp checkout. The working tree also contains pre-existing and concurrent changes outside this list; they were not reset or included in the redesign.

- `apps/extension/src/popup/PopupApp.tsx`
- `apps/extension/src/popup/PopupApp.test.tsx`
- `apps/extension/src/popup/PopupComponents.tsx`
- `apps/extension/src/popup/PopupDispatch.tsx` (new)
- `apps/extension/src/popup/popup.css`
- `apps/extension/src/popup/main.tsx`
- `apps/extension/src/sidepanel/SidePanelApp.tsx`
- `apps/extension/src/sidepanel/CloudAsk.tsx`
- `apps/extension/src/sidepanel/main.tsx`
- `apps/extension/src/settings/SettingsApp.tsx` (visual edits alongside inherited Memory work)
- `apps/extension/src/settings/main.tsx`
- `apps/extension/src/onboarding/OnboardingApp.tsx`
- `apps/extension/src/onboarding/main.tsx`
- `apps/extension/src/setup/RunModePanel.tsx`
- `apps/extension/src/content/thread/ThreadPanel.tsx`
- `apps/extension/src/content/shell/surface.ts`
- `apps/extension/src/styles.css`
- `apps/extension/src/ui/product-tokens.css`
- `apps/extension/src/ui/dispatch.css` (new)
- `apps/extension/src/ui/dispatch-motion.ts` (new)
- `apps/extension/src/ui/DispatchThreads.tsx` (new)
- `apps/extension/src/ui/DispatchCount.tsx` (new)
- `apps/extension/src/ui/Pigeon.tsx`
- `apps/extension/src/ui/pigeon.css`
- `apps/extension/src/ui/orb-markup.ts`
- `apps/extension/src/ui/orb.css`
- `scripts/build-browser-fixture.mjs`
- `tests/browser/fixtures.ts`
- `tests/browser/dispatch.spec.ts` (new)
- `docs/dispatch-redesign.md` (new)

## Preserved boundaries and limitations

No backend protocol, persistence schema, authentication, capability negotiation, mail classification, tracker allocation, Gmail sending or provider architecture was changed. RUN_DIAGNOSTICS, ON_DEVICE_STATUS, panelState, ASK_INBOX and OPEN_COMPOSE_DRAFT remain unchanged. The only behavioral guard in the side panel discards a stale category response so it cannot overwrite a newer selection. Existing approve/reject confirmation and idempotency behavior is preserved.

The new list brief deliberately opens the real Gmail thread or asks about its subject. Draft generation and insertion remain in their existing Gmail/Ask flows, rather than guessing recipients or adding a second draft pipeline. Category counts are local records, not invented Cloud totals. Production Cloud syncing, actual Gmail backfill, provider readiness and live indexing/model download were not run or claimed. Their genuine states are represented by the existing diagnostics and worker signals.
