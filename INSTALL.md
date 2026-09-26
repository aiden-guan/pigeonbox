# Installing PigeonBox — instructions for AI agents

> **Humans:** you don't need to read this. Paste this into your coding agent (Claude Code, Codex, Cursor, etc.):
>
> ```text
> Install PigeonBox for me by following https://raw.githubusercontent.com/aiden-guan/pigeonbox/main/INSTALL.md
> ```

---

**Agent:** you are installing PigeonBox, an open-source (MIT) Chrome extension that adds on-device email triage, summaries, drafts, and optional open/click tracking to Gmail. The extension and on-device AI can run locally. Email tracking is a separate service: a localhost tracker is only for development on this computer and cannot receive opens from another person's mail client. Follow these steps in order, report progress briefly, and ask the user before creating cloud resources or setting provider secrets.

## 1. Check prerequisites

- `node --version` must be **20.0.0 or higher**. If Node is missing or older, ask the user before installing it (suggest `brew install node` on macOS, `winget install OpenJS.NodeJS.LTS` on Windows, or https://nodejs.org).
- `git --version` must work.
- Google Chrome, Edge, Brave or another Chromium browser (version 116+) must be installed. Do not install a browser without asking.

## 2. Get the code

Ask the user where to put it if they have a preference; otherwise use `~/pigeonbox`.

```bash
git clone https://github.com/aiden-guan/pigeonbox.git ~/pigeonbox
cd ~/pigeonbox
```

If the folder already exists and is a PigeonBox clone, run `git pull` instead.

## 3. Run the automated setup

```bash
npm run setup -- --open
```

This checks Node, installs dependencies, creates a gitignored `.env` with a generated local token, builds every package, verifies the built `manifest.json`, and opens `chrome://extensions` plus the build folder. It is safe to re-run. It takes a few minutes on first run.

Success means `apps/extension/dist/manifest.json` exists. If setup fails, show the user the last ~30 lines of output and consult `docs/local-setup.md` before retrying.

## 4. Offer public tracker setup

Lead with public tracker setup as the recommended next step for recipient open/click tracking. Ask which service the user prefers and guide them through the matching guide. If they only want local inbox features and on-device AI, they can skip tracking:

- **Convex** — one hosted service with a durable database: [docs/convex-self-hosting.md](docs/convex-self-hosting.md).
- **Cloudflare Worker + Supabase** — Cloudflare serves the public HTTPS tracking endpoint; Supabase Postgres stores events durably: [docs/self-hosting.md](docs/self-hosting.md).

Supabase by itself is not the tracking endpoint; it is the database used by the Cloudflare Worker option. A Cloudflare Worker without Supabase has a public URL but uses volatile memory, so it is for testing only. The `npm run tracker` server at `127.0.0.1` is also for local testing: other devices and mail clients cannot reach your computer at that address.

The generated personal API token is in the gitignored `.env` and `.local/tracker.txt`. Keep it private: do not print it in chat, commit it, or send it to PigeonBox. Enter it only into the user's chosen tracker provider and the extension's **Settings → Email tracking**. Follow the provider guide to confirm its public `/health` endpoint is healthy before connecting it.

If the user does not want tracking, continue with the local extension setup; inbox features do not depend on a tracking service.

## 5. Hand off the one manual Chrome step

Chrome does not allow programs to install unpacked extensions, so the user must do this themselves. Do **not** try to automate `chrome://extensions`. Tell the user exactly this, substituting the absolute path:

> Almost done — three clicks in Chrome:
> 1. In the `chrome://extensions` tab that just opened, turn on **Developer mode** (top right).
> 2. Click **Load unpacked** and choose `<ABSOLUTE PATH>/apps/extension/dist`.
> 3. Open https://mail.google.com and click the PigeonBox icon in the toolbar. Pick **On this computer** when asked how PigeonBox should run.

## 6. Other optional setup

- **Local tracker development:** `npm run tracker` starts a server on this computer (memory storage by default). It is not the setup for recipient open tracking.
- **Ollama for stronger local models:** see https://ollama.com; PigeonBox uses `http://localhost:11434`.
- **Updating later:** `git pull && npm run setup`, then click the reload icon on the PigeonBox card in `chrome://extensions`.

## Rules

- Never reveal email content or tokens from `.env` and `.local/` in chat, Git, logs, or to PigeonBox. Do not transfer whole local config files. If the user approves a tracker deployment, have them enter the token directly into that provider's secret settings and the extension's local Settings form.
- Never modify the user's Chrome profile or settings directly.
- Do not sign the user up for PigeonBox Cloud; on-device AI should remain the default.
- "On this computer" selects local AI behavior; it does not configure email tracking.
- Never recommend the localhost or memory-only tracker for real recipient-open tracking.
