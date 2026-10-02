# PigeonBox Correspondence

Implemented October 2, 2026 across the extension and Cloud account UI. This pass integrates with the unified workspace already being implemented in the same checkout. Backend, owner identity, permissions, tracking attribution, and workspace persistence changes belong to that concurrent architecture work.

## Audit and direction

The extension had several competing visual layers: legacy `gi-*` surfaces, copper/ink `pb-*` dispatch styles, Tailwind utilities, isolated Gmail shadow styles, and the Cloud account stylesheet. The popup was being retired in favor of one workspace. An isolated preview also omitted the shared entrypoint styles, so it was not a reliable representation of the shipped surfaces until corrected.

| Before | After | Why |
| --- | --- | --- |
| Dark defaults mixed with hardcoded light controls | Intentional light and slate dark palettes with semantic aliases | Appearance remains coherent across iframe, shadow root, settings, and Cloud |
| Repeated brand, intelligence, summary, and detail labels | Person, subject, interpretation, date, actions | Information supplies the hierarchy |
| Several rounded card and button treatments | 6 px controls, 8 px cards, 14 px shell; two shadow depths | Geometry communicates role |
| Large mascot and repeated sprite motion | Approved sprite at 24–38 px in work; 48 px in welcome | Personality does not compete with reading |
| A panel appears after the pill disappears | One shell unfolds around one persistent Pidgy node | Source and destination are spatially legible |
| Indefinite decorative work and shimmer | Event-driven finite SVG resolution and static network skeletons | The product rests when work is done |
| Ask draft opens Gmail immediately | Prepared object can be read and edited before an explicit Gmail action | The user controls the handoff |
| Tracking treated as a generic status block | Focusable path of known events with uncertainty and timestamps | Detection is not presented as proof of reading |

The marketing site’s existing `halftone.js` provided the dot vocabulary. Its continuously redrawn canvas is appropriate to a large marketing image; an extension status needs a different budget. The product uses 35 SVG marks instead. No marketing-site behavior was copied into Gmail.

The visual direction is correspondence: cool neutral surfaces, small copper accents, crisp editorial hierarchy, tiny approved Pidgy poses, and material transitions only when an object changes meaning. Normal navigation and command results remain immediate.

## Architecture

- `apps/extension/src/ui/product-tokens.css` is the source of color, typography, spacing, geometry, border, elevation, and motion roles. Legacy `gi-*`, ink, paper, and copper variables resolve to these semantic roles.
- `ui/system.css` supplies shared product composition and component states. Page entrypoints load it after legacy styles so those states have consistent precedence.
- `ui/Primitives.tsx` exposes small native-element primitives: Button, IconButton, Input, Surface, Status, and ContextCard. Existing command rows, mail rows, source chips, menus, and disclosure components keep their accessible behavior and receive the shared styles. There is no second general-purpose component framework.
- `ui/motion.ts` resolves WAAPI timings from CSS and observes actual visibility without polling. `ui/continuity.ts` transfers geometry between related views.
- `content/shell/workspace.ts` owns the Gmail shadow shell; the existing unified React workspace renders inside its iframe. The pill and expanded shell share one DOM object and one Pidgy node.
- `ui/appearance.tsx` provides System → Light → Dark using one extension-local preference. The Gmail host follows the same preference through the existing presentation-message bridge; it never reads trusted extension storage directly. Cloud web follows the operating-system color scheme.
- The Cloud account UI imports an identical copy at `apps/web/public/control/product-tokens.css`. `control.css` maps its existing variables to these roles. Cloud copies are byte-identical at validation time; future token edits must update both copies.

This pass adds no animation dependency, remote font, canvas, WebGL surface, model request, or new backend endpoint. Gmail category chip colors and the recognizable Gmail provider mark retain their host/provider semantics.

## Token system

| Role | Values / rules |
| --- | --- |
| Type | Display 32, title 20, section 13, body 14, secondary 13, label 12, metadata 11, compact 12, numeric 20, code 12 px |
| Type weight | Regular 400, medium 500, strong 600; compact metadata is not blanket uppercase |
| Reading | System sans; local serif for small prepared-work numbers; system mono for technical values; 1.25 / 1.4 / 1.65 leading; 62 ch reading width |
| Spacing | 4, 8, 12, 16, 20, 24, 32, 40 px; 20 px workspace gutter, 12 px at compact widths |
| Geometry | 4 px small badges, 6 px controls, 8 px cards/tooltips, 12 px larger surface, 14 px shell; pill only for collapsed workspace and switches |
| Targets | 32 px compact icon controls; 36 px primary controls; larger bounds retained where useful |
| Border | Default separation, interactive, selected, focus, warning, and error roles; focus uses a visible 2 px outline |
| Elevation | Low and floating shadow depths; menus use the low elevation family; inline content has no shadow |
| Light | Paper `#fafbf9`, raised white, ink `#253039`, muted `#64717b`, copper `#9a4b2e` |
| Dark | Slate `#191f24`, raised `#21292f`, foreground `#e7ecea`, muted `#a2afa9`, copper `#e2a184` |
| State | Green success, ochre warning, muted red error, slate tracking; every important state also has text or structure |
| Motion | Instant 0, quick 100, standard 180, expressive 260, resolution 680 ms; one shared ease-out and optional restrained spring curves |

Structural animations use transform and opacity. Their short delays are limited to resolving workspace controls after its shell exists. Inputs are live immediately; no typing or command selection waits for motion. Resolution is a finite small-region signature, not a 680 ms navigation delay. Reduced motion resolves the same states immediately.

## Five signature families

1. **Unfolding workspace.** The visible shell bounds are captured before a transition is canceled. FLIP interpolates from the actual pill position to the expanded shell. The same sprite translates independently, so its pixels do not stretch. Controls and content resolve after the shell starts. Closing removes content first and contracts the shell. Duplicate storage echoes cannot cancel a running transition. Rapid reversals use the currently visible geometry.
2. **Information resolution.** DotField supports idle, listening, analyzing, searching, connecting, resolving, and success. A small field moves once from disorder or directional structure to its final glyph. Summary conclusions resolve before secondary details in two short blocks. Answers are shown as readable text, never typed character by character.
3. **Prepared correspondence and context handoff.** A prepared Home reply has a copper edge, tiny ready Pidgy, clear review action, and honest placement copy. The card’s geometry, sender, and subject carry into review. Current conversation carries into a compact Ask context bookmark. Local prepared replies become editable in the same envelope before the explicit Gmail handoff. The transfer cache stores only rectangles, expires after 1.2 seconds, and retains no message text or DOM clones.
4. **Flight path.** Known send and detection events appear as a restrained horizontal path. A missing send timestamp becomes “Tracking on.” Detections use a dashed node and the existing uncertainty note; delivery and reading are never invented. Hover or focus reveals precise metadata. Escape dismisses the tooltip without closing the workspace. Details remain semantically associated with each node.
5. **Completion.** Task checks acknowledge immediately, retain the row while persistence is pending, compress only after success, then close the list space through the existing dispatch layout mechanism. Failures restore the unchecked task and show an actionable error. Completed work remains discoverable. Suggested tasks have a dashed source treatment until explicitly saved.

Prepared-draft placement keeps the existing safety and placeholder rules. No signature causes an email to be sent automatically.

## Pidgy state rules

All poses reuse the approved four-column sprite sheet. The body center and baseline remain fixed. Productivity surfaces use small sprites; welcome is the only larger placement.

| State | Expression and motion | Appropriate use / forbidden use |
| --- | --- | --- |
| Idle | Neutral first frame, no motion | Collapsed shell and quiet workspace; never pulse merely to attract attention |
| Active | Alert/open pose, static | Immediate intentional interaction; do not animate basic navigation |
| Thinking / analyzing | Indexing pose, one finite sprite response | Requested interpretation; no perpetual work loop |
| Searching | Attentive pose, finite response | Real search alongside an explicit status label; no fake progress |
| Drafting | Prepared pose, finite response | A draft request in progress; do not distract from Gmail typing |
| Ready | Prepared pose with small green spot, static | A reply actually exists; label and CTA carry the meaning |
| Success | Prepared pose, one short response | Persisted task completion; no confetti or repeated celebration |
| Attention | Concerned pose and small warning spot, static | A useful required action; never routine mail advertising |
| Warning / error | Concerned/error pose, static | Known actionable failure; pair with error text and retry when available |
| Offline / asleep | Resting pose with subdued treatment | Explicit unavailable or quiet state; do not imply a network failure for an empty inbox |

Legacy indexing, working, opened, and sleeping names remain aliases so existing components keep their APIs. Pidgy and dots are decorative (`aria-hidden`); status text is authoritative. Visual state messages to the shell contain no email contents and are accepted only from its own iframe and origin.

## Concepts evaluated and rejected

The five selected families above scored best on usefulness, clarity, repetition tolerance, and implementation cost. These alternatives were considered against the same criteria:

| Concept | Decision and tradeoff |
| --- | --- |
| Envelope unfolding | Selected: useful object continuity, bounded geometry interpolation, high repetition tolerance |
| Dot settlement into meaning | Selected: ties existing identity to actual work; 35 finite marks instead of a renderer loop |
| Prepared paper handoff | Selected: preserves a reply’s origin; immediate context with a clear editor |
| Context bookmark transfer | Selected within correspondence handoff: compact source continuity without extra navigation chrome |
| Semantic flight path | Selected: useful only when real event metadata exists; omitted elsewhere |
| Compression and list closure | Selected as completion: confirms persistence and preserves neighboring positions |
| Ambient flock around inbox | Rejected: continuous CPU and attention cost without new information |
| Magnetic buttons and elastic cursor | Rejected: makes ordinary controls less predictable and offers no keyboard benefit |
| Persistent intelligence halo | Rejected: visual noise, ambiguous state, and generic AI styling |
| A pigeon crossing every conversation | Rejected: forced metaphor, blocks reading, poor repetition tolerance |
| Character-by-character reply reveal | Rejected: delays reading and editing; content is already composed |
| Celebratory postmarks or confetti | Rejected: daily completion should feel quiet and reliable |
| Gravity-driven inbox reordering | Rejected: heavy motion and unstable reading positions |
| Shimmering orbs during network fetch | Rejected: unmeasured progress and continuous decorative work |

## Performance and accessibility

DotField allocates no animation while idle, hidden, or initially offscreen. Its visibility observer starts one finite pass; hiding pauses existing work, returning resumes that work rather than allocating a second pass, reduced motion cancels it, and unmount disconnects the observer and cancels animations. No requestAnimationFrame, persistent interval, or canvas redraw loop was added. Pidgy pauses offscreen and runs finite responses only for relevant states.

The shell has one layout measurement at each structural state change, not on every animation frame. The existing bounded pointer/keyboard drag implementation is preserved. Context continuity is transform-only with an inert decorative overlay removed on completion or cleanup. Gmail content loading and route detection remain owned by the existing architecture.

Keyboard move and Shift+arrow resize, collapse/reopen, dock/float input retention, command search/selection/Escape/focus restoration, source links, native task checkboxes, and draft editing retain semantic names and focus behavior. Tooltips support focus, hover, and Escape. Important states use words, checkmarks, dashed nodes, or native checked values as well as color. Main text, muted text on raised surfaces, and accent button text are tested at 4.5:1 in both themes. High contrast and reduced transparency have explicit treatments. Reduced motion removes product animation while retaining hierarchy and information.

## Validation and launch boundaries

Deterministic verification covers typecheck, lint, unit tests, extension/build packaging, token contrast, compact widths, interruption, reduced motion, finite/offscreen dot lifecycle, draft transport, input preservation, commands, tasks, and synthetic Gmail SPA behavior. Cloud tests exercise the actual local web assets with the real router and disposable test data. Theme tests cover 320, 390, 900, and 1280 px Cloud widths; extension checks cover 280–680 px page widths and bounded narrow/normal Gmail layouts.

Screenshots in `test-results/design-*.png` are disposable fixture captures, not real customer mail. Stable copies and the exact verification counts/performance results are recorded in the companion validation report.

Before launch, verify the produced build in real signed-in Gmail: typing and scrolling under actual mailbox volume, reading-pane/sidebar combinations, browser zoom at 80/100/125/150%, and real recipient tracking behavior. Synthetic timing is not a production performance guarantee. The existing large InboxSDK/transformer chunks still produce bundle warnings; this design pass introduces no heavy visual renderer but does not remove those underlying dependencies. The two-repository token copy is intentionally explicit and needs a release-time sync check. No deployment, publication, push, or commit is part of this pass.
