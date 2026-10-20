# README capture provenance

These are browser screenshots of the **compiled extension**, captured with Playwright and the repository's existing disposable-profile fixture. They are not generated images or a hand-written recreation of the product.

Mail, summaries, prepared replies, authentication, and Cloud responses are synthetic. No model was asked to produce the displayed text, no Google account was connected, and no email was sent. Local summaries are seeded into IndexedDB; hosted responses come from the contract-validated fixture in [tests/browser/fixtures.ts](../../tests/browser/fixtures.ts).

[capture.json](capture.json) records the application source commit, extension version, UTC capture time, and viewport dimensions. That commit identifies the compiled application, not a release containing these documentation edits. PNG dimensions are twice the CSS viewport in each direction.

## Reproduce

From the repository root, install locked dependencies and Chromium, then build into an isolated directory:

```bash
npm ci
npx playwright install chromium
PIGEONBOX_OUT_DIR=/tmp/pigeonbox-readme-extension npm run build
node scripts/capture-readme.mjs --extension /tmp/pigeonbox-readme-extension
```

The helper adds test fixture entries only to the explicitly supplied build, creates a temporary test under ignored `tmp/`, opens disposable Chromium profiles, and refreshes the five PNGs plus metadata. It refuses the normal working extension directory. Do not load the capture build into your everyday Chrome profile. The original [working build](../../apps/extension) and release ZIP are separate artifacts.

## Capture specification

All routes below are extension-origin `workspace.html` in the disposable profile. Scale is 2×; reduced motion is enabled. Images include only the application viewport, without browser or OS chrome. Feature panels share a 3:4 ratio to fit the vertical workspace; the hero is 16:9.

| Filename | CSS viewport | Mode and interaction state |
| :--- | :--- | :--- |
| `hero.png` | 960 × 540 | Cloud Home with the fixture's Needs you queue visible |
| `feature-triage.png` | 480 × 640 | Local Inbox → Respond with three synthetic threads |
| `feature-companion.png` | 480 × 640 | Open the first local thread's Pidgy Brief; seeded summary and actions visible |
| `feature-drafting.png` | 480 × 640 | Cloud → Prepared drafts → Pricing; unresolved price placeholder retained |
| `feature-ask.png` | 480 × 640 | Cloud Chat → “Who needs pricing?”; fixture answer, source, and coverage note visible |

The 600-pixel-and-wider inbox layout has an existing regression: a stale grid rule in `apps/extension/src/ui/dispatch.css` conflicts with the current inbox children. Local inbox captures use the normal panel width. No application CSS was changed for these images.

## Optional live acceptance captures

Use a dedicated test mailbox with non-sensitive mail. These captures would supplement the fixture images; they have **not** been produced by this presentation pass.

| Destination | Route and viewport | State to verify before capture |
| :--- | :--- | :--- |
| `assets/readme/live-gmail-workspace.png` | `https://mail.google.com/mail/u/0/#inbox`, 1440 × 900, 2× | Actual installed extension, 480-pixel workspace, indexed test threads, diagnostics connected |
| `assets/readme/live-gmail-draft.png` | Open the test thread in Gmail, 1440 × 900, 2× | A real provider-generated reply placed in the composer and reviewed; leave it unsent |
| `assets/readme/live-tracking.png` | Gmail → Waiting, 1440 × 900, 2× | A controlled recipient interaction after a separate sender-preview check; keep attribution caveat visible |

Live screenshots alone do not establish delivery, model accuracy, privacy guarantees, or store publication. Follow the [manual acceptance checklist](../../docs/VERIFICATION.md).
