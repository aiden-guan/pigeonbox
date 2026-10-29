# Threat model

Covers the extension, the standalone trackers (`workers/tracker`, `convex/`) and the self-hosted PigeonBox server (`packages/server`, `workers/api`, `workers/server-tracker`, `apps/web`). Code calls server mode `cloud`.

## Assets

1. Email content in the Gmail page and the local IndexedDB index.
2. Credentials: BYOK API keys, tracker personal tokens, server refresh/access tokens.
3. The ability to act in Gmail (draft, archive) as the user, and, on a server with a Google connection, through the Gmail and Calendar APIs.
4. Tracking records (recipients, subjects, open events).
5. On a server: each account's data (tenant isolation), stored Google refresh credentials, the AI provider key and the owner's AI spend, the server's encryption keyring and Supabase service key.

## Trust boundaries

| Boundary | Control |
|---|---|
| Gmail page (untrusted JS, possibly hostile email HTML) ↔ content script | Content script runs in the isolated world. MAIN world is empty; InboxSDK injects only its own vendored `pageWorld.js`. Email HTML is converted to text before rendering in React UI. |
| Content script ↔ service worker | `senderMaySend` allowlists the message types a Gmail content script may send; settings, sign-in, run mode, index clearing, Gmail actions and downloads require an extension page. Content scripts receive only public settings. |
| Extension storage ↔ content script | `chrome.storage.local`/`.session` are `TRUSTED_CONTEXTS`. |
| Service worker ↔ AI providers | Only the provider the user selected. Host permissions for providers are optional and requested per origin. Server mode never falls back. |
| Service worker ↔ tracker | Tracker token/server token stay in the worker. Tracker hosts are optional permissions. |
| Service worker ↔ PigeonBox server | TLS; protocol version header; Zod validation both ways; tokens bound to the issuing origin; PKCE with state check. |
| Anyone with a Google account ↔ server | `ALLOWED_EMAILS` access list checked on sign-in, on every token verification and again when computing capabilities. |
| Server API ↔ database | Service role on the server only; every query scoped by the user ID from the verified token; always-on queries run as the restricted `pigeonbox_app` role under RLS. |
| Google Pub/Sub ↔ server | Push requests verified (Google-signed OIDC token, audience, service account) before any work. |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| A hostile email or Gmail script reads secrets | Secrets never enter the page or content script; storage restricted to trusted contexts. |
| A compromised content script changes settings or exfiltrates via the server | Privileged messages refused from content scripts; content scripts cannot start sign-in or change mode. |
| Extension-origin spoofing | `sender.id` and origin checked; `externally_connectable` limited to the dashboard origin a build was made for (loopback too in source builds), and the bridge never returns keys or tokens. |
| Remote code | All JS/WASM ships in the package; CSP `script-src 'self' 'wasm-unsafe-eval'`; package validation rejects remote scripts. Model weights are data. |
| Secrets bundled by the build | Only `VITE_*` variables reach the bundle; release packaging scans for credential patterns and for literal values from local env files and refuses to package. `tracker-config.json` and source maps are excluded. |
| Token sent to the wrong server | Server session bound to API origin; `normalizeBaseUrl` rejects non-HTTPS (except loopback) and credentials in URLs. |
| Sign-in CSRF / code injection | PKCE S256 + random `state` checked on return; redirect URIs allowlisted server-side (`ALLOWED_EXTENSION_IDS`, `ALLOWED_WEB_ORIGINS`). |
| A stranger signs in to someone's server and spends their AI budget | `ALLOWED_EMAILS` is required in production; an identity not on it cannot finish signing in or use a token it holds. `*` is an explicit choice. Per-account and server-wide AI limits cap spend. |
| Open redirect via click tracking | Only `http:`/`https:` destinations stored at creation; stored destination re-validated before redirect. |
| Timing attack on tracker token | Constant-time comparison in Worker and Convex. |
| IDOR on tracked emails (server) | Management store scoped to the authenticated user; tracking IDs are random. |
| Client-side capability bypass | Capabilities computed server-side from the access list and the server's configuration; every route that needs one re-checks it. |
| Raw email in logs | Server logs only metadata (enforced by a canary regression test); AI Gateway payload logging off; no request body logging; optional Sentry reports are content-free. |
| Automatic sending | The extension has no send path; tier 3 actions (send, delete, spam, unsubscribe) always need the user. On a server, sending and invitations always create an approval that only the signed-in person can decide (API tokens and MCP clients cannot). |
| Stored Google credentials or summaries leak from the database | Encrypted with AES-256-GCM under per-purpose keys from `DATA_ENCRYPTION_KEYS`, bound to user and record; message bodies are not stored. |
| SSRF (server) | Outbound requests go to configured endpoints (AI provider, Supabase, Google APIs, optional web search); user-supplied URLs (webhooks, web research) go through an SSRF-safe fetch. |

## Self-hoster responsibilities

Running a server makes you its operator. The code cannot protect against these:

- **`server.env`** holds the Supabase service-role key, database password, AI provider key and Google OAuth client secret. It is gitignored; keep it that way and keep it off shared machines.
- **`.local/server-secrets.json`** holds the generated encryption keyring and salts. Anyone with it and a database copy can decrypt stored data; losing it makes stored data unreadable. Back it up privately.
- **`ALLOWED_EMAILS`** decides who can use your server, your AI key and your Google project. Keep it to the people you mean; `*` lets anyone with a Google account in.
- Supabase, Cloudflare, Google Cloud and AI provider accounts, their access controls and their billing alerts are yours to secure.
- Updates: pull and redeploy with `npm run server:deploy` to get fixes.

## Known limitations

- A tracker personal token pasted into the extension is readable by anyone with access to the browser profile. It only protects the user's own tracker.
- The experimental ChatGPT web-session provider depends on unofficial endpoints. It is excluded from release builds.
- Open tracking can be spoofed or blocked; it is a signal, not proof.
- Tracking classification logic exists in three implementations (client, Worker, Convex) that must be kept in step by tests.
- Whoever operates a server (or can read its Supabase project with the encryption keys) can read what it stores for every account on it.
