# Installing PigeonBox Local — instructions for AI agents

> **Humans:** you don't need to read this. Paste this into your coding agent (Claude Code, Codex, Cursor, etc.):
>
> ```text
> Install PigeonBox Local for me by following https://raw.githubusercontent.com/aiden-guan/pigeonbox/main/INSTALL.md
> ```

---

**Agent:** you are installing PigeonBox, an open-source (MIT) Chrome extension that adds on-device email triage, summaries and drafts to Gmail. Local mode needs no account, no API key and no cloud service. Follow these steps in order, report progress briefly, and stop to ask the user if anything fails.

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

## 4. Hand off the one manual step

Chrome does not allow programs to install unpacked extensions, so the user must do this themselves. Do **not** try to automate `chrome://extensions`. Tell the user exactly this, substituting the absolute path:

> Almost done — three clicks in Chrome:
> 1. In the `chrome://extensions` tab that just opened, turn on **Developer mode** (top right).
> 2. Click **Load unpacked** and choose `<ABSOLUTE PATH>/apps/extension/dist`.
> 3. Open https://mail.google.com and click the PigeonBox icon in the toolbar. Pick **On this computer** when asked how PigeonBox should run.

## 5. Optional extras (only if the user asks)

- **Local open tracking:** `npm run tracker`, then paste the URL and token from `.local/tracker.txt` into **Settings → Email Tracking**.
- **Ollama for stronger local models:** see https://ollama.com; PigeonBox uses `http://localhost:11434`.
- **Updating later:** `git pull && npm run setup`, then click the reload icon on the PigeonBox card in `chrome://extensions`.

## Rules

- Never send email content, tokens from `.env`, or `.local/` files anywhere.
- Never modify the user's Chrome profile or settings directly.
- Do not sign the user up for PigeonBox Cloud; Local mode is the goal.
