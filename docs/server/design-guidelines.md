# PigeonBox: the inbox courier

> Written for the former product website, which is no longer part of this repository. It is kept as the reference for PigeonBox's visual identity (palette, type, the pixel courier, motion rules). The generated assets and pages it mentions under `apps/web/public/brand/` were removed with the website.

## Purpose
Make a Gmail extension feel useful, personable, and unmistakably PigeonBox. The page sells a lighter inbox through a readable product demonstration. Its signature is a pixel courier perched on the product window, with a complete departure and return.

## Reference study — September 26, 2026
Reviewed the public pages visually in the browser, including their rendered hero compositions. These are principles to adapt, not layouts or assets to copy.

- [Superhuman Mail](https://superhuman.com/mail): clear outcome, one primary conversion action, large product evidence. Adopt the readable demo and concise outcome. Avoid borrowing its purple campaign treatment or unverified productivity claims.
- [Raycast](https://www.raycast.com/): focused headline and a strong proprietary visual identity; product interactions become the subject. Adopt the disciplined focal point and tactile interactions. PigeonBox has its own daylight palette rather than Raycast's dark/red identity.
- [Mobbin](https://mobbin.com/): generous breathing room, strong type hierarchy, compact navigation. Reviewed its public marketing page, not its gated screen library.
- [shadcn/ui Blocks](https://ui.shadcn.com/blocks): predictable controls, quiet borders, structured information and readable density. Use these principles inside product demonstrations; do not install a component framework into this static website just for a visual refresh.

## System
| Role | Value | Use |
| --- | --- | --- |
| Ink | #142D48 | Headlines, actions, dark feature section |
| Sky | #DFEDF4 | Hero and courier world |
| Pigeon blue | #547D9B | Secondary display text |
| Postal yellow | #FFE17C | Local choice and small action emphasis |
| Paper | #F8FAFB | Main reading surface |
| Body text | #536579 | Supporting text on light surfaces |

Typography: Avenir Next / Avenir / Segoe UI with system fallbacks for interface and display. Display weight 650, tight tracking, two deliberate headline lines. Utility text uses SFMono-Regular or monospace at 10–11px. Product content must stay readable: phone view promotes the companion panel rather than shrinking a whole desktop screenshot.

Layout: 1240px maximum reading width, 1030px product preview, 20px phone gutters. Hero centered above product; alternating editorial feature scenes; dark drafting section; two clear choices (on this computer, or your own server); quiet privacy explanation; sky-backed closing action. Maintain 70–120px section spacing depending on viewport.

Use rounded controls consistently. Button motion should explain press/hover states, not pull controls away from the pointer. Keep one clear primary action. Preserve installation URLs and configuration-driven server behavior.

## Motion
- Flight: fixed accessible button; hover only for fine pointers; click, touch, Enter and Space can activate it. 180ms anticipation, 1270ms accelerating departure, 250ms offscreen interval, 1400ms decelerating return, 190ms landing settle.
- Distinct wing poses run at roughly 13 frames per second. Travel uses requestAnimationFrame independently of the pose clock. No rotation-only substitute for flapping.
- Keep the hit target fixed. Never attach hover to an invisible bridge. Prevent duplicate flights while airborne.
- Reset on resize, hidden tab, and reduced-motion preference changes. Reduced motion leaves the courier perched and all content readable.
- Reveal sections once, with short staggered mail arrivals. No endless decorative loops, autoplay marquee, cursor chase, or scroll hijacking.
- Product walkthrough is explicitly started, pauses offscreen, and advances manually with reduced motion.

## Imagery and copy
The generated sky is atmosphere, not a substitute for product content. The pixel pigeon keeps its grey head, cream belly, brown satchel and orange feet. Product examples remain explicitly illustrative. Never invent customers, statistics or proof of email reading. Keep data-routing caveats accurate.

Avoid italic-serif SaaS headings, random numbered features, floating icon confetti, repetitive cards, fake trust logos and a new mascot style in every section.

## Generated assets
Built-in image generation was used. Original files are preserved; project copies live in `apps/web/public/brand/`.

- `pigeon-flight-atlas.png`: twelve poses in a four-column, three-row transparent sheet. Used through individually registered CSS sprite crops in `flight-frames.js`; polygon boundaries exclude overlapping neighbors in the final two flight poses. Inspect every cell at `flight-study.html`.
- `courier-sky.png`: panoramic pale sky and edge clouds, reused for opening and closing.

### Flight prompt
Create a production animation sprite atlas for this exact adorable pixel art messenger pigeon. Preserve grey head, cream belly, charcoal outlines, orange feet and brown diagonal satchel. Transparent background. ONE atlas, exactly 4 columns by 3 rows, twelve equal square cells, no labels no lines no text. Each bird centered consistently at same body anchor and same scale, generous padding wings never cross cell boundaries. Read left to right: 1 perched standing facing right; 2 crouch anticipation; 3 push off with legs extended wings half raised; 4 wings fully up above back; 5 wings sweeping forward horizontal; 6 powerful wings fully down; 7 recovery half folded wings; 8 wings fully up; 9 horizontal glide wings extended; 10 landing wings braking raised feet forward; 11 landing crouch wings half folded; 12 standing settled identical to first. Actual distinct anatomically coherent wing poses for a smooth flight cycle, not rotated copies. Crisp painstaking hand drawn pixel sprite art on transparent alpha. Keep body and face consistent across all twelve frames. Atlas landscape 4:3.

### Sky prompt
Wide panoramic website background artwork 3:1 aspect ratio. A beautifully art directed soft pale powder blue summer sky, a few sculptural ivory cumulus clouds clustered ONLY along the bottom edge and extreme corners, huge completely empty flat pale sky blue center and upper 75 percent for dark website typography. Subtle analog airbrush illustration, editorial travel poster atmosphere, delicate cloud texture, restrained dimensionality. Blue #dcecf3 and white #f7faf9. No sun no birds no buildings no text no symbols no gradients of purple, no dramatic lighting. Bright airy quiet spacious high quality.

## Verification
Repository verification passed: vendor integrity, secret scan, TypeScript, 72 tests. Browser checked at desktop and 390px: hero, readable companion demo, menu toggle, manual walkthrough, flight wing pose and completed reset. Flight and visual checks are separate from backend tests. This is a local implementation, not a production deployment.
