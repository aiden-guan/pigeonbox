# PigeonBox / Copper Perch

The direction keeps the Pixel Perch messenger pigeon and trades purple illumination for copper, ivory and soot. Glass comes from translucent layers, bright inner edges, soft refraction and dark backing surfaces. Crisp text sits above the glass. Pixel texture belongs to the mascot, not body typography.

## Research

Reviewed the live official sites on September 25, 2026:

- [Fyxer](https://www.fyxer.com/ai-email-assistant): warm off-white, black typography, strong hierarchy and clear product language. Borrow the warmth and simplicity.
- [Shortwave](https://www.shortwave.com/): deep blue background, blue accents, prominent assistant input and grouped inbox workflows. Borrow the clear inbox/assistant separation, not the palette.
- [Superhuman Mail](https://superhuman.com/mail): neutral page, generous spacing, purple controls and atmospheric product imagery. Borrow the spacing and focused hierarchy, not the purple identity.

## Palette

| Role | Color |
| --- | --- |
| Soot background | `#151512` |
| Glass backing | `#292923` |
| Ivory text | `#f4f0e8` |
| Secondary text | `#aba99e` |
| Copper control | `#dda77a` |
| Focus / dark-surface signal | `#edbb93` |
| Light Gmail surface signal | `#935023` |

## Implemented surfaces

Popup, inbox/ask side panel, Gmail thread companion, onboarding, settings, command palette, tracking popovers, row indicators, compose tracking toggle and contextual menus. Functional provider/tracking flows are retained. Extension display name is PigeonBox.

The standalone development fixture is `/src/preview/index.html` on the extension Vite server. It renders the actual components with fictional messages and a local Chrome API shim; it is not a production build entry. Start with `npx vite --host 127.0.0.1 --port 5173` from `apps/extension`.

## Mascot asset and motion

Built-in Image Gen was used with the supplied Pixel Perch image as the identity reference. Source: `apps/extension/brand-src/pigeon-states.png` (1254 × 1254, alpha preserved). The sheet is not a regular grid, so `apps/extension/scripts/pack-pigeon.py` isolates each pose and repacks all 20 into `apps/extension/public/brand/pigeon-sprites.png`, a 4 × 5 grid of 320 × 256 cells sharing a body center and foot baseline.

Four distinct frames each for idle, indexing, drafting, open detected and error. Status follows component data. Motion uses stepped frame changes rather than a CSS bounce of a still illustration. Reduced-motion preference freezes the first frame. Reduced transparency uses opaque backing surfaces.

### Generation prompt

Use case: identity-preserve. Create a production pixel art ANIMATION SPRITE SHEET for the gray messenger pigeon in the supplied reference. Preserve its exact charming chunky pixel style, gray body, ivory belly, black eyes, peach beak and feet, brown diagonal messenger satchel. ONLY the sprites, no UI, text, letters, borders, grid lines or shadows. Transparent background. Output a square sheet exactly 4 columns by 5 rows of equally sized square cells (20 sprites), consistent scale and foot baseline in EVERY cell, ample transparent padding. Each row is a four-frame seamless animation of one status. Row 1 IDLE: gentle breathe, head tilt, blink, return. Row 2 INDEXING: pigeon beside a tiny charcoal terminal with warm amber screen marks, head looks down then up, wing taps keys across four frames. Row 3 DRAFTING: pigeon holding ivory notepad, pencil wing moves to write across four frames. Row 4 OPEN DETECTED: pigeon holding magnifying glass with wing and head subtly raising it across four frames. Row 5 ERROR: puzzled pigeon touching head, tiny terracotta exclamation symbol, head tilts and returns across four frames. Exactly 4 distinct sequential frames per row and exactly 5 rows, equally spaced and aligned, character centered within each cell. No purple anywhere. Charcoal/gray, ivory, tan leather and muted copper only. Crisp visible pixel edges. All characters and props fit fully inside their own cells. Generate the entire atlas as one image.

## Verification

- Extension production build and TypeScript checks passed.
- 34 existing targeted tests passed across popup, thread intelligence, sent-status, settings and provider permissions. Updated two palette expectations to copper.
- Browser inspection: desktop overview, 320px actual side panel without horizontal overflow, 360px onboarding, back/continue, Ask prompt loading, drafting transition, error and retry affordance, all five sprite rows.
- Screenshot: `docs/design/copper-perch-preview.png`.
- Installed Gmail integration and actual AI/tracking requests were not exercised in this visual redesign pass. The preview contains fictional data and does not establish live backend readiness.
- Existing jsdom warnings for modern CSS `@starting-style` syntax persist; the browser renders the styles. Build retains pre-existing large-bundle warnings.

## Current compact Pidgy model

The approved model follows the gift and lantern references. The current source is a regular 384 by 480 transparent atlas of 96px cells at apps/extension/brand-src/pigeon-states.png. pack-pigeon.mjs uniformly packs it into the existing 320 by 256 app cells; pack-pigeon.py remains a compatibility entry point. App icons derive from its idle cell. Film assets derive from the same production sheet and the approved flight cycle. The earlier irregular-source notes above describe the original generation.
