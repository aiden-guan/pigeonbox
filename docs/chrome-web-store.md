# Chrome Web Store readiness

Status checked in the owner dashboard on 2026-10-03: existing item `hmoiiokfmacghpddabpgaajolbeljhcp` has v0.4.0 **Published to testers**. That historical status does not confirm a later submission. The v0.5.0 submission kit at `release/chrome-web-store-20261003/` is a local ignored archive; its older screenshots and promo tiles were removed during this cleanup. Use the current listing images in `docs/store/`. The current package is the unified v0.5.3 ZIP described below; preparing it does not upload or submit it.

Listing text, dashboard answers and images: [store/listing.md](store/listing.md). Privacy policy: [PRIVACY.md](../PRIVACY.md).

## Package

Build with `npm run package`. The ZIP (`release/PigeonBox-vX.Y.Z.zip`) is what gets uploaded. Packaging fails if it finds:

- source maps, `.env*`, `.dev.vars`, `tracker-config.json`, TypeScript sources, tests, `node_modules`,
- credential patterns or literal values of secrets from local env files,
- `<script src>` pointing at a remote URL,
- a CSP allowing `unsafe-eval`, `unsafe-inline`, remote sources or wildcards,
- files referenced by `manifest.json` that are missing,
- a manifest version that differs from `package.json`.

Default release builds include both Local and Cloud using the public production endpoints in `scripts/lib/release-config.mjs`, turn off experimental features (ChatGPT web sign-in), and omit source maps. Local remains the default. Upload the canonical ZIP manually when publication is authorized; do not push a release tag merely to prepare it.

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
- [x] Store description consistent with the README and the unified Local + Cloud build
- [x] Screenshots (1280×800), small promo tile (440×280) and marquee (1400×560) in `docs/store/`, generated from real UI with fictional mail by `apps/extension/scripts/make-store-assets.py`
- [x] Store installs hide the GitHub update check and the developer Reload button; Chrome updates them

Remaining dashboard actions:

- [x] Existing publisher account and item confirmed in the dashboard
- [ ] Update the existing item with the final kit ZIP and listing from [store/listing.md](store/listing.md)
- [ ] Replace the five older screenshots; upload the small and marquee promo tiles (currently empty)
- [ ] Replace the older description and homepage; add the support URL and current reviewer instructions
- [ ] Check Privacy practices against the prepared answers, then change visibility from testers to Public for the public launch
- [ ] Submit for review and confirm the dashboard status. Store approval timing is external.
- [ ] Optional: set up release automation (below), after the manual release

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

Run `npm run package` to produce one `release/PigeonBox-vX.Y.Z.zip` containing both modes. Packaging pins public production URLs regardless of local environment variables and rejects existing output without those endpoints. `--cloud` remains a compatibility alias for the same package. There is no second Cloud ZIP.

Cloud availability in the extension does not open public account registration or grant a subscription. Consent, account access, Google authorization and paid capabilities remain runtime checks. Real-time Pidgy checks remain off until explicitly enabled. CI loads the extracted ZIP to verify Local defaults, Cloud availability, consent and dashboard settings. See "Cloud release verification" in [store/listing.md](store/listing.md).

## Settings live on the dashboard

The toolbar gear, the options page and onboarding open `https://usepigeonbox.com/dashboard?ext=<extension ID>`. The dashboard talks to the extension through `externally_connectable` (release builds accept only usepigeonbox.com; packaging fails otherwise) and shows Local settings in Local mode and Cloud settings in Cloud mode. The bridge is `apps/extension/src/background/web-bridge.ts`: it never returns API keys or tokens, cannot change the Cloud API, switches to Cloud only with consent from a click, and asks for host permissions in its own `grant.html` window. Connecting Cloud is a PKCE handoff: the worker keeps the verifier, the dashboard runs sign-in and passes back the code, so a Cloud build needs no `chromiumapp.org` redirect, only its ID in the API's `ALLOWED_EXTENSION_IDS`. `settings.html?here=ai` is the AI setup page (model downloads, ChatGPT sign-in and provider access need an extension page); `settings.html?here` keeps the full in-extension page for development and offline use. Adding `externally_connectable` adds no permission warning.

## Local builds with the store ID

An unpacked build gets an ID derived from its folder path, so it differs from the store item's. Cloud sign-in (`https://<id>.chromiumapp.org/` redirects, `ALLOWED_EXTENSION_IDS`) only accepts known IDs. To give `dist/` the store ID, copy the item's public key (Developer Dashboard → Package → View public key) into `apps/extension/.env.local` as `PIGEONBOX_EXTENSION_KEY=…` and rebuild; the build logs the resulting ID. Release builds never include the key, and packaging fails if a manifest has one. Chrome can't have the store copy and the unpacked copy with the same ID installed in one profile, so use a separate profile for development.

## After listing

Add the store link to README's Install table and the Chrome Web Store badge, and point the Cloud site's `site-config.json` `installUrl` at the store. Do not add a badge before the listing exists.
