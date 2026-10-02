# Pidgy future designs · v1

New artwork for later use, generated with the built-in Image Gen tool using the
approved `public/brand/pigeon-sprites.png` as Pidgy's identity and style reference.
These assets are kept outside `public/` until a future feature selects them.

Each transparent PNG contains four columns and two rows. Read each row left to
right as a four-pose sequence. The design sets are:

| Sheet | First row | Second row |
| --- | --- | --- |
| Cozy | Tea sip | Sleepy rest |
| Delivery | Present a parcel | Paper airplane |
| Cheer | Friendly wave | Star celebration |
| Explorer | Read a map | Curious lantern |

Open `index.html` for a light/dark frame gallery and animation preview.
`manifest.json` records the actual PNG size, exact frame rectangles, full alpha
visible content bounds, and padding for every frame. Use those recorded
dimensions rather than assuming the generated canvas matches the prompt size.

Future consumers should use the complete frame rectangle, keep the image's alpha
channel, and preserve its aspect ratio. Set `image-rendering: pixelated` when
displaying at small sizes. A state that should hold still can use its first frame;
the gallery's row playback is an optional pose preview, not timing guidance for a
production feature. Respect reduced motion when integrating animation.

The exact generation prompts are saved under `prompts/`. Crop validation includes
isolated effects and accessories and requires at least 16 pixels between visible
art and every cell edge. Bounds use alpha values of 4 or higher; the generator's
residual alpha values of 1–3 (under 1.2% opacity) are counted separately. Original
PNG pixels and alpha are preserved. See `validation.json` for results.
