# Tracked email from AI clients

Needs a server with a database (`cloud_mcp`) and the always-on Gmail connection with Send permission. Opens and link tracking use the server tracker.

## Why the send must go through PigeonBox

Gmail browser extensions instrument the compose window. An assistant sending through another Gmail API connector does not pass through that window. Asking a model to keep an HTML pixel is also unreliable: its email tool may accept only plain text or transform the HTML. No PigeonBox MCP tool can intercept a different connector's send, or add a pixel after delivery.

PigeonBox therefore owns final message construction and Gmail dispatch. The assistant sends plain text to `request_send`; the person reviews the sender, recipients, text and tracking choices in PigeonBox. After approval, the server constructs a `multipart/alternative` MIME message with the approved plain text and an escaped HTML alternative containing tracked links and the shared 1×1 pixel. Gmail receives that complete MIME directly. The assistant never receives a pixel to render or copy.

This uses Google's documented [MIME/base64url send API](https://developers.google.com/workspace/gmail/api/guides/sending). The diagnosis is architectural; it does not assume every client uses the same undocumented HTML sanitizer.

## Assistant workflow

Connect to `https://<API host>/v1/mcp` (for a default deployment, `https://pigeonbox-api.<your-subdomain>.workers.dev/v1/mcp`) with Read and Write access. The Google connection also needs Send enabled. Request a separate email for each cold-email recipient when separate engagement attribution is needed:

```json
{
  "name": "request_send",
  "arguments": {
    "mailbox": "you@example.com",
    "to": ["recipient@example.com"],
    "subject": "An introduction",
    "body": "Hi Sam,\nHere is the demo: https://example.com/demo\nThanks!",
    "track_opens": true,
    "track_links": true,
    "idempotency_key": "outreach-sam-20261015-01"
  }
}
```

1. `request_send` creates an approval, never a send. Opens and links default on; set both false for explicitly untracked mail. `mailbox` is required when several active accounts are connected. `thread_id` optionally selects a synced reply and preserves the RFC Message-ID reply headers.
2. Review or edit the message in PigeonBox → Approvals. The final approved text is the text/plain part; HTML is generated from that same text. Only full HTTP(S) URLs are linkified. Gmail-internal links, tracker links and unsubscribe/opt-out paths are not wrapped. At most 100 distinct links can be tracked. No model-provided HTML executes.
3. Call `get_send_status` with `approval_id`. `deliveryStatus: "sent"` means Gmail accepted the message, not that it arrived in an inbox. The receipt includes Gmail IDs, and a tracking ID when tracking was enabled. Pending, rejected, expired, failed and unconfirmed are distinct states.
4. Call `get_tracked_email` with `tracking_id` for authoritative counters, up to 200 recent classified events, confidence, explanations and an attribution note. These reads do not fetch a pixel or visit a redirect, and do not expose raw user agents or IP hashes. Existing thread-level `get_tracking_activity` remains available.

Retries must reuse the same idempotency key. A repeat request returns the original approval without changing its text or sending again. Tracking IDs and click IDs remain stable across job retries. If delivery is unconfirmed, check Sent mail before initiating any new send; the server never automatically replays an uncertain Gmail dispatch. Tracker bookkeeping after a successful send can retry using the saved Gmail receipt without dispatching another message.

Use this instruction in the assistant:

> Use PigeonBox request_send for tracked email. Wait for my approval in PigeonBox, then check get_send_status and get_tracked_email. Do not send that same request through another email tool. Do not open the tracking URLs to inspect status.

## Client connections

**ChatGPT hosted connections:** OpenAI's [MCP authentication guide](https://developers.openai.com/plugins/build/auth) expects OAuth 2.1 for authenticated hosted connections; a configuration containing a custom bearer header alone is insufficient. Add the remote MCP URL after completing the OAuth setup below. Sign in with PigeonBox, then explicitly choose Read and Write. A client-side tool confirmation does not approve the email inside PigeonBox.

**Claude:** Its [remote connector documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) supports OAuth and fixed request headers. Either use OAuth after setup below, or create a scoped token in PigeonBox → API & MCP and set `Authorization: Bearer <token>` in the connector's request headers. The token is shown once and can be revoked immediately.

**Muse Code:** Meta's [official MCP documentation](https://dev.meta.ai/docs/muse-code/extending) documents Streamable HTTP, headers, environment interpolation, and OAuth login. A token connection can be configured as:

```json
{
  "mcp_servers": {
    "pigeonbox": {
      "transport": "streamable_http",
      "url": "https://<API host>/v1/mcp",
      "headers": { "Authorization": "Bearer ${PIGEONBOX_MCP_TOKEN}" },
      "enabled": true,
      "mode": "required"
    }
  }
}
```

For OAuth, omit the fixed header and use `muse mcp login pigeonbox` after server setup. Muse's consumer app is a separate product; its exact connector onboarding was not established by these sources. Any client that can call the authenticated PigeonBox MCP endpoint uses the same tracked-send path. A browser-only automation sending directly from Gmail still bypasses it.

## Server setup for OAuth

OAuth uses the existing Supabase identity provider, as described in [Supabase's MCP authentication guide](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication). No custom authorization-code, PKCE, refresh-token or client-registration server is implemented in the Worker.

1. `npm run server:deploy` applies `20261015081802_mcp_oauth_grants.sql` with the other migrations. It adds OAuth client IDs to the existing server-only, owner-scoped developer grants and installs a restricted Auth hook. It preserves existing API tokens.
2. Set the exact canonical resource in the private configuration table, for example for a default deployment:

   ```sql
   insert into app.mcp_oauth_settings (singleton, resource)
   values (true, 'https://pigeonbox-api.<your-subdomain>.workers.dev/v1/mcp')
   on conflict (singleton) do update set resource = excluded.resource;
   ```

   It must match your API URL (`API_BASE_URL`) plus `/v1/mcp` exactly. Use your custom domain instead if you set `API_URL` in `server.env`.
3. Before enabling OAuth clients, configure Supabase's Custom Access Token Hook to call `public.pigeonbox_mcp_access_token_hook`. If the project already uses a hook, compose the behavior into that hook. Ordinary person sessions retain their existing claims. OAuth access tokens receive the exact MCP audience and role `pigeonbox_mcp`. The hook uses only issuer-controlled top-level claims, never user metadata.
4. **Do not create a Postgres role or authenticator membership named `pigeonbox_mcp`.** This token must not gain direct Data API access as the authenticated person. The Worker verifies its JWT issuer, signature, expiry, audience, role and `client_id`, then checks a live owner/client-specific PigeonBox grant on every request. An OAuth token cannot be used as a normal dashboard session, decide an email approval, manage tokens, or use the tracker's management API. See [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security) and [token-hook documentation](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook).
5. In Supabase Auth → OAuth Server, enable the managed OAuth 2.1 server, use asymmetric JWT signing, and configure the authorization UI to the canonical **API-host** `/dashboard` URL. Supabase adds `authorization_id` to that URL. The dashboard preserves it through sign-in and opens the consent view. Register the client's exact callback URI, or enable managed dynamic client registration if needed. Request the `openid` identity scope; PigeonBox's Read/Prepare/Write permissions are chosen separately on its consent screen.
6. Set `MCP_OAUTH_ENABLED=true` in `server.env` and run `npm run server:deploy`. Keep this flag off until steps 1–5 are complete. The deploy sets `TRACKER_BASE_URL` to your tracker's public HTTPS origin; every allowed account has `cloud_tracking`, and the Google connection needs Send permission. Nothing silently downgrades a tracked request to untracked mail if setup is missing.
7. Verify `GET /.well-known/oauth-protected-resource/v1/mcp`, the unauthenticated MCP `401` discovery challenge, and a real client consent flow. OAuth grants appear alongside API tokens in the existing revocation UI. Revocation disables the local grant first, immediately blocking MCP access, then revokes the managed provider grant and refresh access. A provider outage cannot preserve the local grant's access.

Do not turn on the Supabase OAuth server before the token hook is configured: default Supabase OAuth tokens otherwise inherit an authenticated user's database role. The application flag alone does not configure Supabase.

## Measurement limits

Pixels depend on recipient image loading. Plain-text readers do not load pixels or use the HTML's tracked links. Gmail image caching, privacy proxies, security scanners, forwarded messages and sender self-views prevent reliable human-read attribution. Apple's [Mail Privacy Protection](https://www.apple.com/legal/privacy/data/en/mail-privacy-protection/) can fetch remote content without the recipient engaging. PigeonBox reuses tracking protocol v3 classification and self-view suppression, and reports uncertain events as such. It does not bypass image blocking or privacy protections. Multi-recipient messages share one tracking record.

This change adds no bulk-sending engine: existing Sequences retain their batch approvals, sending windows, limits, unsubscribe links, suppressions and stop-on-reply behavior. MCP sends retain individual approval. Nothing in MCP authorizes an unattended outreach campaign.

## Verification

When this was implemented (October 15, 2026, before the server moved into this repository): `npm run verify` passed (704 tests passed, 13 skipped), the 21 focused MCP tests passed, and the MCP browser test plus the existing dashboard suite passed all 20 Chromium checks. Both Worker bundle dry runs passed. No migration, provider configuration, deployment or real email send was performed for that work.

Automated coverage exercises the real local API, migrated Postgres/RLS, encryption, approval jobs, MIME construction, fake Gmail, the real tracker handler, and signed OAuth fixtures. Browser coverage exercises setup copy, sign-in continuity, explicit scope selection, escaped client names and expired-request recovery. These tests do not establish real ChatGPT/Claude/Muse connections, real Supabase OAuth issuance, real Gmail transport, inbox placement or recipient-client image behavior. Those require a deployment and controlled live acceptance with two mailboxes you own.

For live acceptance, connect a client with Read and Write, request a tracked message to the second owned mailbox, approve it, inspect Gmail Show original for both MIME alternatives and the pixel/links, check the receipt IDs, then perform a recipient image load and link visit. Verify classified events, sender self-view suppression, retry behavior, and immediate connection revocation. Never use customer recipients for this acceptance run.
