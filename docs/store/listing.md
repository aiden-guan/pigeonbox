# Chrome Web Store listing

What to enter in each field of the [developer dashboard](https://chrome.google.com/webstore/devconsole). The images in this folder are rendered by `node docs/store/src/render.mjs` (add `--capture` to refresh the UI captures first). They use real PigeonBox UI from the website's Gmail walkthrough, which is built from the extension components with fictional mail, and the website's halftone renderer and Pidgy atlases, so the PigeonBoxSite checkout must sit next to this one. The process and the release automation are in [../chrome-web-store.md](../chrome-web-store.md).

Keep this in step with the product. The store rejects listings that describe features the uploaded build does not have. The release ZIP runs on the user's computer only: it carries no server address, so this listing describes Local mode. People who run their own PigeonBox server build from source.

## Package

Build with `npm run package`: the upload artifact is `release/PigeonBox-vX.Y.Z.zip`, with its adjacent `.sha256` checksum. Update your existing store item rather than creating another one. Do not push a release tag: the tag workflow may submit to the store automatically. The store takes the name, summary and icons from `manifest.json`.

## Store listing tab

**Title** (from the manifest): PigeonBox

**Summary** (from the manifest, 132 characters max):
AI inbox intelligence and email open tracking for Gmail. Runs on your computer; open source.

**Description:**

```
PigeonBox is a quieter, smarter Gmail. It sorts your inbox, summarizes threads, drafts replies in your voice, and answers questions about your mail. By default all of it runs on your computer.

ON YOUR COMPUTER BY DEFAULT
In Local mode, PigeonBox reads the Gmail page you already have open. It does not use the Gmail API, does not ask for access to your Google account, and keeps its mail index in your browser. No account is required, and PigeonBox sends no usage analytics.

WHAT IT DOES
• Sorts threads into Respond, Waiting, FYI and Notifications. The rules work even with AI turned off.
• Adds a thread companion beside each conversation, with a summary, dates, key details and to-dos.
• Drafts replies that match your tone and signature. Drafts open in Gmail for you to review. Drafts are never sent automatically.
• Ask your inbox: "What needs a reply?", "What did I send Sam last week?", or "Draft an email to Maya saying I'll be late." Answers come from mail already indexed on this computer.
• Follow-up reminders for mail you sent that hasn't had a reply.
• Optional open and click tracking through a tracker you host. An open is a signal that an image loaded, not proof the message was read.

CHOOSE YOUR AI
• A model that runs in your browser on WebGPU, downloaded once
• Chrome's built-in Gemini Nano
• Ollama on your computer
• Your own API key for an OpenAI-compatible provider
• Or no AI at all. Sorting and search still work.
Email content only leaves your computer when you pick a provider that needs it, and only goes to that provider.

OPEN SOURCE
PigeonBox is MIT-licensed. The code, the privacy model and reproducible release builds are at github.com/aiden-guan/pigeonbox. Anyone can run their own PigeonBox server for always-on features by building from source.
```

**Category:** Productivity → Communication

**Language:** English

**Graphic assets:**

| Field | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800) | `screenshot-1.png` … `screenshot-5.png`, in that order |
| Small promo tile (440×280) | `promo-small.png` |
| Marquee promo tile (1400×560) | `promo-marquee.png` |

The store rejects images and badges that read as store status or promotion (Red Nickel, 2026-10-11, for "Free" on the marquee). Keep words such as free, new, recommended, premium, best, top and #1 out of the graphics and their source pages; pricing belongs in the Distribution tab.

**Official URL:** none (it requires a Search Console-verified domain).
**Homepage URL:** https://github.com/aiden-guan/pigeonbox
**Support URL:** https://github.com/aiden-guan/pigeonbox/issues
**Mature content:** No

## Privacy practices tab

**Single purpose:**
PigeonBox helps people manage their Gmail inbox: it sorts and summarizes mail, drafts replies for review, answers questions about their mail, and optionally tracks opens and clicks on sent emails.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, their list of tracked emails, and session state. |
| `unlimitedStorage` | The local mail index lives in IndexedDB, and on-device AI models (about 270–920 MB) are stored in the browser's private file system so they are downloaded once. |
| `notifications` | Tells the user when a tracked email is opened or a follow-up reminder is due. |
| `alarms` | Schedules checks for tracking events and follow-up reminders. |
| `scripting` | Injects the bundled InboxSDK page script into Gmail, which InboxSDK requires under Manifest V3 to add PigeonBox's UI to Gmail. The script ships in the package. |
| `sidePanel` | Shows the sorted inbox and Ask Pigeon in Chrome's side panel. |
| `offscreen` | Runs on-device AI (WebGPU/ONNX and Gemini Nano) in an offscreen document, because the service worker cannot. |
| `identity` (optional) | Requested only if the user signs in to their own PigeonBox server, to run the sign-in flow. |
| Host `https://mail.google.com/*` | PigeonBox works inside Gmail: it reads the mail the user has open and adds its UI there. |
| Optional hosts (`https://*/*`, `localhost`, `127.0.0.1`) | Requested one origin at a time, only when the user connects a service they chose: their AI provider's endpoint, their own tracker, Ollama on their computer, Hugging Face to download a model, or their own PigeonBox server. PigeonBox never requests broad access. |

**Remote code:** No. All JavaScript and WebAssembly ship in the package. On-device model weights downloaded from Hugging Face are data run by the bundled runtime, not code.

**Data usage.** Select:

- **Personally identifiable information**: the user's Gmail address and name, read from the page to tell their messages apart from others'.
- **Personal communications**: email content, processed to sort, summarize, search and draft.
- **Website content**: the Gmail page PigeonBox reads.

Leave the others unchecked. PigeonBox sends no analytics and reads no location, browsing history or payment data. Data only goes to services the user configures (their AI provider, tracker or server).

**Certify all three:**

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/aiden-guan/pigeonbox/blob/main/PRIVACY.md

## Distribution tab

- **Payments:** Free
- **Visibility:** Public. Use Unlisted for a beta item.
- **Regions:** All

## Test instructions tab (for reviewers)

```
Local review needs no PigeonBox account or API key.

1. Install PigeonBox and open https://mail.google.com with any Google account that has a few emails.
2. On first run, PigeonBox asks how it should run. Choose "On this computer".
3. Click the PigeonBox toolbar icon to open its workspace. Choose "Inbox" and a category: Respond, Waiting, FYI or Notifications. Sorting works without AI. Only mail observed on this computer is available in the local index.
4. Open an email thread, then choose "Home" in the workspace. "Current conversation" follows the thread and shows its category and available details.
5. Optional AI: Settings (the gear in the workspace) → AI → Change AI. On a WebGPU-capable computer, download LFM2-700m and allow the model-download host when Chrome asks. Other on-device options are listed with their availability; an API key is not required for on-device AI.
6. With AI connected, open an incoming thread with a simple request and click "Draft reply". Review the generated text in Gmail's reply box. It is never sent automatically; discard it after reviewing. Summaries appear in Current conversation. Choose "Ask" to ask about locally indexed mail.

Local open and click tracking require a tracker the user hosts and permission for that specific origin. Tracking is unavailable until configured and is not required to review the extension.
```

## Release verification

1. Build the single canonical ZIP with `npm run package`. Extract it and run `PIGEONBOX_BROWSER_EXTENSION_PATH=/path/to/extracted npx playwright test tests/browser/release.spec.ts` directly. Do not inject browser fixtures into the upload package.
2. Submit the canonical ZIP and this listing only when store publication is authorized. Building and pushing source does not publish it.
