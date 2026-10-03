# Contour motion

The loading system uses an original copper contour language with a different silhouette and gesture for each work state. Analyzing retains the travelling latitude wave and two intersecting orbits. It replaces the dot field that previously settled after one animation while an operation was still pending.

## References

- [21st thinking orbs](https://21st.dev/community/components/explore/thinking-orbs): different visual rhythms for different kinds of work; small inline and larger avatar treatments.
- [Emil Kowalski: 7 Practical Animation Tips](https://emilkowal.ski/ui/7-practical-animation-tips): immediate press feedback, short custom ease-out transitions, and menus that emerge from their trigger.
- [React Bits Orb](https://www.reactbits.dev/backgrounds/orb): a continuous, recognizable form during processing.

The implementation uses original SVG artwork and CSS rather than importing these components. No additional dependency or remote assets are required.

## Behavior

`Orb` and the legacy `DotField` adapter use the same artwork as plain-DOM busy toasts. `idle` is a static sphere; analyzing uses the contour wave; searching becomes a concentric radar with a rotating sweep and a detected point; listening becomes seven breathing waveform bars; connecting becomes two contour hemispheres approaching one another with a travelling link; drafting becomes four flowing ribbons with a nib moving across successive rows; resolving becomes an aperture of six petals folding inward once; success reveals a checkmark once. Shapes crossfade and gently settle during state changes. Only work states loop.

All movement uses transform and opacity. Visibility observers pause animations offscreen and in background documents; replacement/removal disconnects the observers. Reduced motion renders a static state, including when the preference changes during an operation. Status text remains separate from the decorative, aria-hidden orb. Colors follow the existing light, dark, and on-accent tokens. Compact rendering removes alternate latitudes and thickens strokes.

Buttons compress to 97 percent on press. Thread menus enter from their top-right trigger. Toasts use an interruptible CSS entry transition. The existing motion duration/easing tokens remain authoritative.

## Preview

Run the extension Vite development server and open `/src/preview/index.html?surface=motion`. Switch states and theme; compare the six work states side by side, inspect compact sizes and inline contexts, and interrupt transitions by switching quickly. This preview is excluded from the production build.

## Verification

- Full `npm run verify` passed, including typecheck, lint, 726 unit tests, build, and release-package validation.
- Final extension build and release package passed after the animation scope correction. The isolated full browser suite passed: 37 tests passed and one skipped.
- `tests/browser/orb.spec.ts` verifies long-request movement, offscreen frozen clocks and resume, runtime reduced-motion changes, removal on request completion, distinct rendered silhouettes under reduced motion, and animation confined to visible artwork.
- Disposable Chromium visual checks covered light/dark themes, 14–136px indicators, 320px and 380px viewports without overflow, rapid interrupted transitions, static idle, and finite success.

The generated ZIP and unpacked build contain the changes. Signed-in Gmail validation and store publication were not performed.
