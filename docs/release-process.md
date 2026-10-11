# Release process

## Versioning

One version for the whole repository: every `package.json`, `apps/extension/manifest.json`, `package-lock.json` and a `## [X.Y.Z]` section in `CHANGELOG.md`. Semantic versioning; Chrome requires each store upload to have a higher version. `npm run check:versions` (part of `verify` and CI) fails when any of them disagree, and the tag workflow also requires the tag to match.

```bash
npm run version:set -- 0.3.0     # writes all package.json files and manifest.json
npm install                      # updates package-lock.json
npm run check:versions
```

## Unified extension package

`npm run package` produces one ZIP with Local and optional Cloud modes. Public production endpoints come from `scripts/lib/release-config.mjs`, overriding shell and local Vite environment values. Fresh installs start in Local; Cloud consent, sign-in, subscription capabilities and Google authorization remain runtime gates. Real-time Pidgy checks remain off by default. `--cloud` is a compatibility alias for this same package.

## Version policy: Store, GitHub and Cloud agree

Every version uploaded to the Chrome Web Store is also a tagged GitHub Release built from the same commit, so the store, the GitHub Release, the tag, `manifest.json`, the package versions and `CHANGELOG.md` never disagree:

1. Tag the commit (`vX.Y.Z`). `release.yml` builds the ZIP, checks it, and creates the GitHub Release.
2. If the repository variable `CWS_EXTENSION_ID` is set, the same workflow uploads and submits that ZIP. If it is not set, upload the ZIP from the GitHub Release by hand. Never upload a ZIP built anywhere else.
3. Raise Cloud's `compatibility.minimumVersion` (remote client config) only to a version that the store has published, and only after its adoption is high enough (see Rollout).

A version that never goes to the store (for example a source-only fix) still gets its `CHANGELOG.md` section, but needs no tag. Older local artifacts belong in the ignored `release/archive/`.

## What a release build proves

`npm run package` (also run by `verify`, CI and the tag workflow) fails unless:

- versions match (above), and the manifest version equals the package version;
- the build is a release build: no source maps, experimental features off, no development rebuild URL, no `key` in the manifest;
- the Cloud endpoints are the production ones in `scripts/lib/release-config.mjs`, are plain HTTPS origins on a PigeonBox production host (`*.pigeonbox.workers.dev` or `usepigeonbox.com`), and are compiled into the bundle;
- `externally_connectable` allows only usepigeonbox.com, the CSP allows no remote or eval code, and no remote script is referenced;
- every manifest permission and host pattern has a justification in [chrome-web-store.md](chrome-web-store.md#manifest-v3-audit);
- no secret pattern, Supabase service-role JWT or local env value appears in any file;
- no source, test, map or env file is in the ZIP.

The tag workflow also fails if the build leaves uncommitted generated files, and rebuilds to prove the ZIP is byte-identical.

## Automated tagged releases

1. Update `CHANGELOG.md`.
2. `npm run verify` locally.
3. Merge to `main` with a green CI run.
4. Tag and push:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

5. `.github/workflows/release.yml` then:
   - checks the tag equals the package and manifest versions,
   - runs a clean `npm ci` and `verify`,
   - builds the release package (`PIGEONBOX_RELEASE=1`),
   - rebuilds from scratch and fails if the ZIP's SHA-256 differs (reproducibility),
   - verifies the extracted ZIP in Chromium,
   - creates the GitHub Release with `PigeonBox-v0.3.0.zip` and `PigeonBox-v0.3.0.sha256`,
   - uploads the same ZIP to the Chrome Web Store and submits it for review, once the store credentials are configured (see [chrome-web-store.md](chrome-web-store.md#release-automation)). Until then, upload it in the dashboard by hand.

6. Store users get the update automatically after review. Users of the GitHub ZIP see it in Settings → Updates.

Both CI and the tag workflow extract and load the canonical ZIP in Chromium to verify Local defaults, Cloud availability, consent and settings persistence before releasing it. Source development builds remain configurable.

The in-extension update checker (unpacked installs only; the Chrome Web Store updates its own installs) lists GitHub releases, picks the highest non-draft, non-prerelease `vX.Y.Z` tag (other releases, like the launch film, are ignored) and looks for the matching `PigeonBox-vX.Y.Z.zip` asset. Keep that tag format and asset name unchanged. Checks are opt-in; sideloaded Chrome extensions still need to be reloaded by the user after downloading.

## Reproducibility

`scripts/lib/zip.mjs` sorts entries, fixes timestamps to 1980-01-01 and writes no OS attributes. Given the same lockfile and Node.js version (`.nvmrc`), the ZIP is byte-identical. Users can check a download with:

```bash
shasum -a 256 -c PigeonBox-v0.3.0.sha256
```

## What is in the ZIP

Only a fresh release build from an isolated temporary staging directory, minus anything `isExcludedFromPackage` matches. Staging is removed after packaging; the ZIP and checksum go to `release/` (or `--out`). Packaging never changes `apps/extension/dist`, the working folder loaded in Chrome. See the checks in [chrome-web-store.md](chrome-web-store.md).

## Rollout of a release that changes the Cloud protocol or client config

Users update over days, and some never do, so Cloud must serve the previous extension and the new one at the same time:

1. Deploy backward-compatible Cloud first (new routes are additive; old clients ignore unknown fields). Leave `CLIENT_CONFIG` and `CLIENT_MIN_EXTENSION_VERSION` unset.
2. Smoke the **current** store version against it (sign-in, compose check, thread card, tracking).
3. Build the new extension with `npm run package`, load the ZIP unpacked, and smoke it against production Cloud.
4. Tag the release (see Version policy) and submit it to the store.
5. After it is published, tune behavior through remote client config: one change at a time, watching Sentry, the `compose check` logs and support reports.
6. Set `compatibility.recommendedVersion` to the new version once it is published.
7. Raise `compatibility.minimumVersion` (and `CLIENT_MIN_EXTENSION_VERSION`) only when an old version is unsafe or nearly unused. Old clients then see "PigeonBox needs an update"; clients older than 0.6.0 instead get the 426 message they already understand.

Emergency: `disabledFeatures` in remote client config switches a client feature off for every 0.6.0+ install within one config TTL; `CLOUD_ROLLOUT` (server) remains the switch for every version.

## Moving Cloud to first-party domains (not done yet)

The release endpoints are still the `workers.dev` hostnames. As of 2026-10-02, usepigeonbox.com is not a Cloudflare zone on the PigeonBox account (its DNS is at Spaceship), so Worker custom domains cannot be attached yet (pigeonbox-cloud `docs/deployment.md`). Moving needs, in order:

1. Make usepigeonbox.com a Cloudflare zone; attach `api.` and `t.` (or `track.`) as Worker custom domains while keeping `workers_dev = true`.
2. Verify DNS, TLS, `/v1/health`, `/v1/version`, CORS for the dashboard origin, the PKCE handoff, and that an existing workers.dev `/open/…` pixel still returns the GIF. Add the new origins to `ALLOWED_WEB_ORIGINS`.
3. Ship an extension whose release config uses the new origins and lists the old tracker in `VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS`.

Sessions: a Cloud session is bound to the API origin that issued it (`background/cloud/session.ts`), and tracked emails are keyed by `cloud:<API origin>` (`config.ts`). A domain change therefore needs, in that same extension release, a narrow migration: when the stored session's origin is a compiled-in previous production origin, refresh it once against the new origin (same Worker, same database), rebind it there, and keep resolving `cloud:<old origin>` tracking IDs as the same issuer. Tokens are never sent to an origin that is not compiled into the build, and if the refresh is refused the person signs in again rather than being silently kept on the old origin. The old `workers.dev` hostnames stay up until that release's adoption is near complete; the tracker hostname stays up permanently for mail already sent.
