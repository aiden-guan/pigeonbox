# Release process

## Versioning

One version for the whole repository: every `package.json`, `apps/extension/manifest.json`, `package-lock.json` and a `## [X.Y.Z]` section in `CHANGELOG.md`. Semantic versioning; Chrome requires each store upload to have a higher version. `npm run check:versions` (part of `verify` and CI) fails when any of them disagree, and the tag workflow also requires the tag to match.

```bash
npm run version:set -- 0.3.0     # writes all package.json files and manifest.json
npm install                      # updates package-lock.json
npm run check:versions
```

## Release package

`npm run package` produces one ZIP that runs on this computer. There is no official hosted PigeonBox server, so a release build carries no server endpoints: `scripts/lib/release-config.mjs` blanks the `VITE_PIGEONBOX_CLOUD_*` values from the shell and local env files, and packaging fails if any of them appears in the output. People who run their own server build the extension from source; `npm run server:deploy` points that build at their server (see [self-hosting.md](self-hosting.md)). Real-time Pidgy checks remain off by default.

## Version policy: GitHub and the Chrome Web Store agree

Publishing to the Chrome Web Store is optional; the tagged GitHub Release is the canonical download. When a version is uploaded to the store, it is the same ZIP as a tagged GitHub Release built from the same commit, so the store, the GitHub Release, the tag, `manifest.json`, the package versions and `CHANGELOG.md` never disagree:

1. Tag the commit (`vX.Y.Z`). `release.yml` builds the ZIP, checks it, and creates the GitHub Release.
2. If the repository variable `CWS_EXTENSION_ID` is set, the same workflow uploads and submits that ZIP. If it is not set and you publish to the store, upload the ZIP from the GitHub Release by hand. Never upload a ZIP built anywhere else.
3. If you run a server, raise its `compatibility.minimumVersion` (remote client config) only to a version the extensions using it already run (see Rollout).

A version that never goes to the store (for example a source-only fix) still gets its `CHANGELOG.md` section, but needs no tag. Older local artifacts belong in the ignored `release/archive/`.

## What a release build proves

`npm run package` (also run by `verify`, CI and the tag workflow) fails unless:

- versions match (above), and the manifest version equals the package version;
- the build is a release build: no source maps, experimental features off, no development rebuild URL, no `key` in the manifest;
- no PigeonBox server endpoint is compiled in: none of the `VITE_PIGEONBOX_CLOUD_*` values from the shell or `apps/extension/.env*` files appears in the bundle, and neither do the local development server URLs;
- the manifest has no `externally_connectable`, the CSP allows no remote or eval code, and no remote script is referenced;
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

Both CI and the tag workflow extract and load the canonical ZIP in Chromium (`tests/browser/release.spec.ts`) to verify that it runs on this computer and that no website can message it. Source builds remain configurable.

The in-extension update checker (unpacked installs only; the Chrome Web Store updates its own installs) lists GitHub releases, picks the highest non-draft, non-prerelease `vX.Y.Z` tag (other releases, like the launch film, are ignored) and looks for the matching `PigeonBox-vX.Y.Z.zip` asset. Keep that tag format and asset name unchanged. Checks are opt-in; sideloaded Chrome extensions still need to be reloaded by the user after downloading.

## Reproducibility

`scripts/lib/zip.mjs` sorts entries, fixes timestamps to 1980-01-01 and writes no OS attributes. Given the same lockfile and Node.js version (`.nvmrc`), the ZIP is byte-identical. Users can check a download with:

```bash
shasum -a 256 -c PigeonBox-v0.3.0.sha256
```

## What is in the ZIP

Only a fresh release build from an isolated temporary staging directory, minus anything `isExcludedFromPackage` matches. Staging is removed after packaging; the ZIP and checksum go to `release/` (or `--out`). Packaging never changes `apps/extension/dist`, the working folder loaded in Chrome. See the checks in [chrome-web-store.md](chrome-web-store.md).

## Rollout of a release that changes the server protocol or client config

Extensions update over days, and some never do, so a server must serve the previous extension and the new one at the same time. For anyone running a server:

1. Deploy the backward-compatible server first (`npm run server:deploy`; new routes are additive and old clients ignore unknown fields). Leave `CLIENT_CONFIG` unset.
2. Smoke the extension version people currently use against it (sign-in, compose check, thread card, tracking).
3. Build the new extension from source against the server, load it, and smoke it.
4. Tag the release (see Version policy).
5. Tune behavior through remote client config (`CLIENT_CONFIG` in `server.env`): one change at a time, watching the logs, the `compose check` log lines and error tracking if you set it up.
6. Set `compatibility.recommendedVersion` to the new version once the extensions using the server can update.
7. Raise `compatibility.minimumVersion` only when an old version is unsafe or no longer used. Old clients then see "PigeonBox needs an update"; clients older than 0.6.0 instead get the 426 message they already understand.

Emergency: `disabledFeatures` in remote client config switches a client feature off for every 0.6.0+ install within one config TTL; `CLOUD_ROLLOUT` (server) remains the switch for every version. See [server/operations.md](server/operations.md#rollout-and-kill-switches).

## Moving a server to a new domain

A server can move from its `workers.dev` hostnames to custom domains (`API_URL` and `TRACKER_URL` in `server.env`). The generated Worker configuration keeps `workers_dev = true`, so the old hostnames keep serving; keep the old tracker hostname up permanently, because mail already sent keeps its original pixel and link URLs. List the old tracker origin in `VITE_PIGEONBOX_CLOUD_TRACKER_PREVIOUS_URLS` (in `apps/extension/.env.local`) so self-view suppression still recognizes those pixels.

A server session is bound to the API origin that issued it (`background/cloud/session.ts`), and tracked emails are keyed by `cloud:<API origin>` (`config.ts`). Moving the API origin therefore means signing in again, and tracked emails issued under the old origin are not carried over to the new one.
