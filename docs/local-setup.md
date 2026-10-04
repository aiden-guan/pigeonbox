# Local setup

PigeonBox's on-device AI and inbox features need only Node.js 20+ and Chrome (or Edge/Brave) 116+. They do **not** need a PigeonBox account, PigeonBox Cloud, Supabase, Stripe, Convex, a Cloudflare account, Docker, or an AI key. Recipient tracking is separate and optional. The guided install offers to set up a public Convex tracker in your own account; tracking recipient opens cannot use a localhost server.

## First run

```bash
git clone https://github.com/aiden-guan/pigeonbox.git
cd pigeonbox
npm run setup -- --tracking --open
```

The tracker setup requires approval before it signs in to Convex or creates/updates cloud resources. Direct interactive runs ask in the terminal; an agent that already received approval uses `--yes`. If approved, it deploys the tracker, confirms `/health`, pre-fills the local extension build, and rebuilds it. To add the tracker later, run `npm run setup:tracker -- --open`.

For a local-only install, use `npm run setup -- --open`; you can add tracking later.

`setup`:

1. checks your Node.js version,
2. runs `npm ci` if dependencies are missing,
3. creates a gitignored `.env` from `.env.example` with a generated tracker token, and `workers/tracker/.dev.vars`,
4. writes `.local/tracker.txt` (private tracker setup notes and a generated personal API token),
5. builds everything and checks the built `manifest.json`,
6. with `--open`, opens the build folder and `chrome://extensions`.

If you use several Chrome profiles, create a gitignored `.local/chrome.json` so `--open` uses the right one:

```json
{ "profileDirectory": "Profile 1", "gmailAccount": "you@example.com" }
```

## Load the extension

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → `apps/extension/dist` (the folder with `manifest.json`).
3. Pin **PigeonBox** and open Gmail.
4. The onboarding page asks how PigeonBox should run. Choose **On this computer** for local AI. This choice is separate from email tracking.

## Choose AI (Local)

Click the **Settings** gear in the PigeonBox workspace, then **AI → Change AI**:

- **Downloaded model**: LFM2 700M/1.2B, Gemma 3 1B, Qwen3 0.6B, Qwen2.5 0.5B, SmolLM2 360M. Runs on WebGPU in an offscreen document. Weights (≈270–920 MB) download from Hugging Face only when you click Download and are stored in the browser's origin-private file system. **Remove** deletes them.
- **Chrome Gemini Nano**: Chrome 138+ desktop with enough memory and disk; Chrome manages the download.
- **API key or Ollama**: OpenAI, any OpenAI-compatible endpoint, or Ollama at `http://127.0.0.1:11434/v1`. Chrome asks for permission to reach that host when you connect.
- **Off**: categories still work with on-device rules.

Email content only leaves the device if you choose a remote provider.

## Develop

```bash
npm run dev          # rebuilds apps/extension/dist on change; click Reload on chrome://extensions
npm run dev:reload   # or: Settings → "Reload extension" rebuilds first, then reloads
npm test             # Vitest (jsdom + fake-indexeddb)
npm run typecheck
npm run lint
npm run verify       # everything CI runs, including the release ZIP check
```

`npm run dev` never starts Convex, a tracker, or any Cloud service.

Use `apps/extension/dist` as the single working extension folder in Chrome. `npm run build`, `npm run dev`, and the reload helper all update this folder. `npm run package` builds in temporary staging and writes a ZIP to `release/`; it does not replace your working build. After rebuilding, reload PigeonBox in `chrome://extensions` and refresh Gmail to replace its running content script.

`npm run dev:reload` starts a small helper on `127.0.0.1:5199` that only accepts requests from Chrome extensions. While it runs, Settings’ **Reload extension** button rebuilds `apps/extension/dist` from your current source before restarting the extension; a failed build leaves the running extension alone. Without the helper the button does a plain reload. Release builds never contact it.

On macOS, `npm run dev:reload:install` keeps the helper running in the background and starts it at every login (a per-user LaunchAgent; logs in `~/Library/Logs/PigeonBox/dev-reload.log`). `npm run dev:reload:status` checks it and `npm run dev:reload:uninstall` removes it. Re-run install if you move the repo or change Node versions.

## Recipient open and click tracking

To record opens when a recipient's mail client loads the tracking pixel, PigeonBox needs a public HTTPS tracker that you own. The guided install defaults to [Convex](convex-self-hosting.md), which provides both the public endpoint and durable database. If you skipped tracking during setup, run `npm run setup:tracker -- --open`.

After Convex setup, the extension's local Settings page is prefilled. Click **Save**, approve Chrome's request to access the tracker, and confirm the status says **Tracker healthy**. The tracker stores tracking records and open/click events, including subject/sender/recipient metadata; it does not store message bodies or drafts.

If you prefer [Cloudflare Worker + Supabase](self-hosting.md), follow that deployment guide, then enter the public URL and personal API token in **Settings → Email tracking**. Supabase alone is not the HTTP tracker.

## Local tracker development

```bash
npm run tracker
```

This starts a server at `http://127.0.0.1:8787` (memory storage by default). A recipient's device cannot reach your computer's `127.0.0.1`, so use it only to test the tracker locally, not for recipient opens. See [tracking.md](tracking.md) and [tracking-debug.md](tracking-debug.md).

## Optional: developing against PigeonBox Cloud

Cloud is not needed for anything above. If you have access to the private `pigeonbox-cloud` repository and run it locally with the mock AI provider, set **Settings → Advanced → PigeonBox Cloud API URL** to `http://127.0.0.1:8788`, save, then choose **PigeonBox Cloud** under **Settings → PigeonBox**.

## Troubleshooting

- **Gmail looks unchanged**: Settings → Advanced → **Run diagnostics**. Check "Gmail tab", "Active integration" and the last Gmail event.
- **Model download fails**: allow the Hugging Face permission prompt and keep the Settings tab open until it finishes.
- **"Chrome has not allowed PigeonBox to reach this tracker"**: open Settings → Email tracking and click **Save** to grant access.
