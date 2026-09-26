# Installing PigeonBox — instructions for AI agents

> **Humans:** you don't need to read this. Paste this into your coding agent (Claude Code, Codex, Cursor, etc.):
>
> ```text
> Install PigeonBox for me by following https://raw.githubusercontent.com/aiden-guan/pigeonbox/main/INSTALL.md
> ```

---

**Agent:** you are installing PigeonBox, an open-source (MIT) Chrome extension that adds on-device email triage, summaries, drafts, and optional open/click tracking to Gmail. The extension and on-device AI can run locally. Recipient tracking needs a public tracker because a localhost service cannot receive requests from another person's mail client. Follow these steps in order and report progress briefly. The default tracker is a Convex deployment in the user's own account. Ask for explicit approval before signing in or creating/updating cloud resources.

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

## 3. Install PigeonBox and ask about the default tracker

First explain that Convex provides a public HTTPS tracker and durable storage in the user's own account, and that it stores tracking records and open/click events, including subject/sender/recipient metadata but not message bodies or drafts. Ask whether they approve creating/updating those cloud resources and setting or replacing the production token. Wait for their answer.

If approved, run:

```bash
npm run setup -- --tracking --open --yes
```

The `--yes` flag records the approval already given in chat. Keep this command attached to an interactive terminal so the user can complete Convex sign-in and any project-selection prompts. The setup checks Node, installs dependencies, creates a gitignored `.env` with a generated personal tracker token, builds the extension, then signs in to Convex and provisions the tracker.

If running the setup directly in an interactive terminal without `--yes`, it asks for the same approval before cloud changes. Do not use `--yes` unless the user has explicitly approved.

After approval, setup creates or uses a project in the user's Convex account, configures a cloud development deployment, deploys the tracker to production, sets the tracker token as a production secret, checks the public `/health` endpoint, pre-fills the URL and token into the local extension build, rebuilds, and opens `chrome://extensions` plus the build folder. Convex account limits and terms apply.

If declined, or if the user wants a local-only install, run `npm run setup -- --open` instead. The user's inbox features and on-device AI work; recipient tracking needs a public deployment. If they approve a tracker later, run `npm run setup:tracker -- --open --yes`; omit `--yes` when running directly in an interactive terminal so the script can ask.

Success means `apps/extension/dist/manifest.json` exists. If setup fails, show the user the last ~30 lines of output and consult `docs/local-setup.md` before retrying.

## 4. Use another tracker provider only when requested

Convex is the default because it provides the public endpoint and durable database in one service. Do not ask the user to choose among providers unless they request an alternative. If they specifically want a different provider, use:

- **Cloudflare Worker + Supabase** — Cloudflare serves the public HTTPS tracking endpoint and Supabase Postgres stores events durably: [docs/self-hosting.md](docs/self-hosting.md).

If the user asked for Cloudflare + Supabase before installation, use `npm run setup -- --open` in step 3, then follow that guide. If they decline Convex because they prefer Cloudflare + Supabase, continue from that guide without rerunning the Convex setup.

Supabase by itself is not the tracking endpoint. A Cloudflare Worker without Supabase has a public URL but uses volatile memory, so it is for testing only. The `npm run tracker` server at `127.0.0.1` is also only for local testing: another device's mail client cannot reach the user's computer at that address.

The generated personal API token stays in gitignored local files and is passed to Convex from a private local env file. The configured tracker URL/token are embedded only in this machine's ignored development build; release builds strip `tracker-config.json`. Never print the token or read out `.env`, `.local/tracker.txt`, or `tracker-config.json` in chat or logs. For a manual Cloudflare setup, the user enters their token into their provider and **Settings → Email tracking**.

## 5. Hand off the manual Chrome steps

Chrome does not allow programs to install unpacked extensions, so the user must do this themselves. Do **not** try to automate `chrome://extensions`. Tell the user exactly this, substituting the absolute path:

> Almost done — finish these steps in Chrome:
> 1. In the `chrome://extensions` tab that just opened, turn on **Developer mode** (top right).
> 2. Click **Load unpacked** and choose `<ABSOLUTE PATH>/apps/extension/dist`.
> 3. Open https://mail.google.com and click the PigeonBox icon in the toolbar. Pick **On this computer** when asked how PigeonBox should run; that choice controls AI and is separate from tracking.
> 4. At Email tracking, choose **Connect tracker in Settings**. If Convex setup succeeded, the URL and token are already filled in. Click **Save** and approve Chrome's request to access the tracker; confirm the status says **Tracker healthy**. If setup was skipped, you can skip tracking here and configure it later.

## 6. Other optional setup

- **Local tracker development:** `npm run tracker` starts a server on this computer (memory storage by default). It is not the setup for recipient open tracking.
- **Ollama for stronger local models:** see https://ollama.com; PigeonBox uses `http://localhost:11434`.
- **Updating later:** `git pull && npm run setup`, then click the reload icon on the PigeonBox card in `chrome://extensions`.

## Rules

- Never reveal email content or tokens from `.env` and `.local/` in chat, Git, logs, or to PigeonBox. Do not transfer whole local config files. The setup script passes the generated token to Convex from a private local file; do not print it or send it to the user in chat.
- Do not run the public tracker setup without the user's explicit approval. If they approved in chat, pass `--yes`; otherwise let the interactive setup prompt them. If they decline, leave the local extension setup complete and explain how to run `npm run setup:tracker -- --open` later (or add `--yes` after they approve in chat).
- Never modify the user's Chrome profile or settings directly.
- Do not sign the user up for PigeonBox Cloud; on-device AI should remain the default.
- "On this computer" selects local AI behavior; it does not configure email tracking.
- Never recommend the localhost or memory-only tracker for real recipient-open tracking.
