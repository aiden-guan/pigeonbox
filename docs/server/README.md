# Server documentation

These documents cover the PigeonBox server: `packages/server` (logic), `workers/api` (the `/v1/*` API and the dashboard from `apps/web`), `workers/server-tracker` (tracking pixel, clicks and per-account tracking API) and `supabase/migrations` (schema). You run it yourself on Cloudflare Workers and Supabase. To set one up, start with the [self-hosting guide](../self-hosting.md).

In the extension this is "your PigeonBox server" (server mode). Code calls the mode `cloud` (`runMode: 'cloud'`, `cloud_*` capabilities, `packages/cloud-client`).

- **Build:** [development](development.md), [architecture](architecture.md).
- **Run:** [operations](operations.md) (logs, jobs, limits, kill switches, key rotation, incidents).
- **Features:**
  - [Document tracking](document-tracking.md): tracked PDFs and the viewer.
  - [Tracked email from AI clients](mcp-tracked-sending.md): MCP `request_send` and OAuth setup.
  - [Chat permissions](chat-permissions.md): how Chat proposes Gmail changes for approval.
  - [Ask conversation continuity](ask-conversation-continuity.md): follow-ups and action review in Ask.
  - [Personal context engine](personal-context-engine.md): memory learned from mail.
  - [Memory conversations and promises](memory-conversations-and-promises.md): the dashboard Memory page.
  - [Ambient compose context](ambient-compose-context.md): real-time Pidgy checks while writing.
  - [Compose latency](compose-latency.md): what was done to make those checks faster.
- **Design:** [visual direction](design-guidelines.md).

Related: the [extension–server protocol](../cloud-protocol.md), the [threat model](../threat-model.md) and the [privacy model](../privacy-model.md).
