# Correspondence validation — October 2, 2026

## Verified

- `npm run verify`: all stages passed, including typecheck, lint, 692 unit tests across 76 files, all builds, and release package validation.
- 34 extension browser checks passed: Home, draft review and placement, commands, Local/Cloud Ask, settings, onboarding, theme persistence, 4.5:1 semantic text contrast, 280–680 px page widths, bounded Gmail shell layouts, rapid interruption, reduced motion, task source/context behavior, dock/float state retention, and no resting product animations.
- Cloud web: 11 browser tests passed against the real local router and disposable fixtures. Both themes and 320/390/900/1280 px widths passed; reduced-motion navigation passed. A mobile focus issue was corrected so a section change returns to the visible heading.
- DotField lifecycle unit test passed: idle/hidden/offscreen allocation is zero; one visible state allocates 35 finite animations; hide pauses, resume does not duplicate, reduced motion cancels, and unmount disconnects/cancels.
- `git diff --check` passed in both repositories after whitespace cleanup.
- Extension and Cloud semantic token copies have identical hashes.

The full extension browser suite passed after the concurrent architecture task corrected its HTTPS image-proxy fixture. The final run also verifies the Gmail shell and iframe stay synchronized when switching appearance through the trusted presentation bridge.

## Measured fixture performance

The design performance record is `/Users/aidenguan/.codex/visualizations/2026/10/02/01a0fbe9-9876-7322-9a96-b4001ac906da/design-performance.json`:

| Measurement | Observed |
| --- | --- |
| Running product animations after settling | 0 |
| Idle measurement window | 600.000 ms |
| Gmail page task time in that window | 1.426 ms |
| Gmail page script time in that window | 0.000 ms |
| Fixture compose text entry and verification | 30 ms |
| Gmail fixture JS heap | 5,482,120 bytes |

An earlier end-to-end fixture sample observed Home setup-to-ready at 411 ms, Ask including its artificial 300 ms server latency at 836 ms, Gmail navigation/thread mount at 374 ms, and a SPA route/single-workspace check at 24 ms. These are measurements of disposable test mail on this machine, not a production benchmark or proof of zero regression in a real mailbox. CDP task/heap values above cover the Gmail page target; iframe animation assertions cover the workspace separately. No real Gmail CPU or memory comparison is claimed.

The content build remains approximately 1.29 MB (383 kB gzip), including the existing InboxSDK integration. Large dependency chunk and mixed static/dynamic agent import warnings remain. No animation framework, shader, canvas loop, or remote product font was added.

## Manual interaction verification

The localhost preview uses production components and fictional messages. Verified open/collapse/reopen, keyboard move/resize controls, light/dark appearance, current-thread context transfer into Ask, a prepared Local reply becoming an editor, edited text retention, and the explicit Gmail handoff feedback. The handoff in the preview is simulated. Automated MV3 browser tests separately exercise the actual extension transport and controlled Gmail composer without sending real mail.

## Visual evidence

Stable captures are saved under `/Users/aidenguan/.codex/visualizations/2026/10/02/01a0fbe9-9876-7322-9a96-b4001ac906da`:

- `design-home-light.png`, `design-home-dark.png`: shared Home hierarchy and controls.
- `design-prepared-reply-dark.png`: continuous reply review, editable text, placement/placeholder precision, and actions.
- `design-gmail-unfolded.png`, `design-gmail-reduced-motion.png`: real extension shell over a synthetic Gmail page.
- `workspace-gmail-narrow.png`: bounded compact Gmail layout.
- `dispatch-command.png`: responsive keyboard command surface.
- `design-cloud-account-light.png`, `design-cloud-account-dark.png`, `design-cloud-account-mobile.png`: actual Cloud web assets in both themes and mobile navigation.

All mail and accounts in these screenshots are test fixtures.

## Before launch

1. Run the produced extension in a real signed-in Gmail profile and check typing, scrolling, initial load, thread switching, reading-pane and sidebar configurations at actual mailbox volume.
2. Verify browser zoom at 80/100/125/150% and actual native side-panel behavior on target platforms. Effective CSS width checks are complete; real zoom is not equivalent to them.
3. Verify real recipient events independently of visual design; the tracking-attribution fixture now passes.
4. Keep the cross-repository token copy synchronized during release. It is currently identical; no automatic private-repository sync was added.
5. Review the combined working tree before publishing because the design and architecture tasks share files. Changes are local and uncommitted by this task; production deployment and store publication remain outstanding.
