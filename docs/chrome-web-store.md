# Chrome Web Store readiness

Status: the package, listing text, images and privacy policy are ready. It has not been submitted yet; there is no public listing.

Listing text, dashboard answers and images: [store/listing.md](store/listing.md). Privacy policy: [PRIVACY.md](../PRIVACY.md).

## Package

Build with `npm run package`. The ZIP (`release/PigeonBox-vX.Y.Z.zip`) is what gets uploaded. Packaging fails if it finds:

- source maps, `.env*`, `.dev.vars`, `tracker-config.json`, TypeScript sources, tests, `node_modules`,
- credential patterns or literal values of secrets from local env files,
- `<script src>` pointing at a remote URL,
- a CSP allowing `unsafe-eval`, `unsafe-inline`, remote sources or wildcards,
- files referenced by `manifest.json` that are missing,
- a manifest version that differs from `package.json`.

Release builds turn off experimental features (ChatGPT web sign-in) and omit source maps.

## Manifest V3 audit

### Required permissions

| Permission | Why |
|---|---|
| `storage` | Settings, tracked-email list, session state |
| `unlimitedStorage` | IndexedDB index and on-device model weights (≈270–920 MB) in the origin-private file system |
| `notifications` | Open/click and follow-up reminder alerts |
| `alarms` | Tracking poll and reminder schedule |
| `scripting` | Injecting InboxSDK's bundled `pageWorld.js` into Gmail's MAIN world, as InboxSDK requires under MV3 |
| `sidePanel` | Split inbox and Ask Pigeon panel |
| `offscreen` | Running WebGPU/ONNX and Gemini Nano outside the service worker (reason `WORKERS`) |
| host `https://mail.google.com/*` | The product works inside Gmail |

Removed in 0.2.0: `tabs`, `activeTab`, and required hosts `chatgpt.com`, `*.convex.site`, `127.0.0.1:8787`, `localhost:8787`.

### Optional permissions (requested at the moment of use)

| Permission | When |
|---|---|
| `identity` | Signing in to PigeonBox Cloud (`launchWebAuthFlow`) |
| `https://*/*` | The user connects a specific HTTPS origin: their BYOK endpoint, their tracker, Hugging Face for model downloads, or PigeonBox Cloud. Each request names the exact origin. |
| `http://127.0.0.1/*`, `http://localhost/*` (and `:8787`, `:11434`) | Ollama, a local tracker, or local Cloud development |

`https://*/*` is declared as optional because BYOK endpoints and self-hosted trackers are user-chosen. Reviewers may ask about it; the answer is that only the origin the user types is ever requested.

### Remote code

All JavaScript and WebAssembly ship in the package: the app bundles, InboxSDK's `pageWorld.js` and `background.js` (vendored from `@inboxsdk/core`), and ONNX Runtime's `ort-wasm-simd-threaded.asyncify.{wasm,mjs}`. CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `wasm-unsafe-eval` is needed to compile the bundled WASM.

Model weights for on-device AI are downloaded from Hugging Face on user request. They are data (ONNX graphs and tensors) executed by the bundled runtime, not code. They are not bundled because of their size (up to ~900 MB each).

InboxSDK: the bundled InboxSDK contains a Google API key that is InboxSDK's own public browser key. The package check allowlists exactly the keys present in `@inboxsdk/core`.

### Experimental ChatGPT web session

Excluded from release builds (`VITE_PIGEONBOX_EXPERIMENTAL=false`): the UI is hidden, the background refuses `CHATGPT_LOGIN`, its tab listeners are not installed, and `chatgpt.com` is no longer a host permission. The code remains in the bundle but is inert. It must not be enabled in a store build.

## Listing checklist

Prepared in this repository:

- [x] 128×128 icon in the package, and a store icon (`docs/store/store-icon-128.png`)
- [x] Single purpose, permission justifications, data-use answers and reviewer test instructions ([store/listing.md](store/listing.md))
- [x] Privacy policy: [PRIVACY.md](../PRIVACY.md), covering Local and Cloud
- [x] Store description consistent with the README and the Local-only build
- [x] Screenshots (1280×800), small promo tile (440×280) and marquee (1400×560) in `docs/store/`, generated from real UI with fictional mail by `apps/extension/scripts/make-store-assets.py`
- [x] Store installs hide the GitHub update check and the popup's Reload button; Chrome updates them

Only the account owner can do:

- [ ] Register a developer account ($5 one-time) and verify the publisher email
- [ ] Create the item: upload the latest release ZIP, fill in the listing from [store/listing.md](store/listing.md), submit for review
- [ ] Test the uploaded ZIP on a clean Chrome profile before publishing (or publish as Unlisted first)
- [ ] Set up release automation (below)

## Release automation

After the item exists, every `vX.Y.Z` tag uploads the release ZIP to the store and submits it for review (`scripts/publish-chrome-web-store.mjs`, Chrome Web Store API v2). The step is skipped while `CWS_EXTENSION_ID` is unset.

1. In [Google Cloud](https://console.cloud.google.com): create or pick a project, enable the **Chrome Web Store API**, create a service account (no roles needed) and a JSON key for it.
2. In the developer dashboard under **Account**, add the service account's email. Note the **publisher ID** (Publisher → Settings) and the item's ID.
3. In GitHub → Settings → Secrets and variables → Actions:
   - variables `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID`,
   - secret `CWS_SERVICE_ACCOUNT_JSON` with the whole key file.
   - Optional variable `CWS_PUBLISH=false` uploads without submitting, so you can submit from the dashboard.

An OAuth client (`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` secrets) works instead of the service account. Its refresh token expires after seven days while the consent screen is in Testing, so prefer the service account.

To publish a release by hand: `CWS_PUBLISHER_ID=… CWS_EXTENSION_ID=… CWS_SERVICE_ACCOUNT_JSON="$(cat key.json)" node scripts/publish-chrome-web-store.mjs release/PigeonBox-vX.Y.Z.zip`.

## Cloud in store builds

A build has PigeonBox Cloud only if it was built with `VITE_PIGEONBOX_CLOUD_API_URL`. The release workflow reads it from the repository variables `PIGEONBOX_CLOUD_API_URL` and `PIGEONBOX_CLOUD_TRACKER_URL`. While they are unset, Settings and onboarding show Cloud as "Coming soon" and the store listing must not advertise it. When Cloud launches, follow "When Cloud launches" in [store/listing.md](store/listing.md).

## Local builds with the store ID

An unpacked build gets an ID derived from its folder path, so it differs from the store item's. Cloud sign-in (`https://<id>.chromiumapp.org/` redirects, `ALLOWED_EXTENSION_IDS`) only accepts known IDs. To give `dist/` the store ID, copy the item's public key (Developer Dashboard → Package → View public key) into `apps/extension/.env.local` as `PIGEONBOX_EXTENSION_KEY=…` and rebuild; the build logs the resulting ID. Release builds never include the key, and packaging fails if a manifest has one. Chrome can't have the store copy and the unpacked copy with the same ID installed in one profile, so use a separate profile for development.

## After listing

Add the store link to README's Install table and the Chrome Web Store badge, and point the Cloud site's `site-config.json` `installUrl` at the store. Do not add a badge before the listing exists.
