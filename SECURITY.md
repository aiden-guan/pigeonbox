# Security policy

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/aiden-guan/pigeonbox/security/advisories/new). Do not open a public issue, and do not include real email content, API keys or tokens in reports. We aim to acknowledge reports within a few days.

In scope: the extension in this repository, the standalone tracker (`workers/tracker`, `convex/`), and the self-hosted PigeonBox server (`packages/server`, `workers/api`, `workers/server-tracker`, `apps/web`, `supabase/migrations`) and its deploy script. There is no PigeonBox-operated service; the security of a particular deployment also depends on how its operator configures and guards it (see the self-hoster responsibilities in [docs/threat-model.md](docs/threat-model.md#self-hoster-responsibilities)).

## Rules the code follows

- No API keys, Supabase service-role keys, OAuth client secrets or personal tokens in the repository or in extension builds. `npm run check:repo` and release packaging scan for them, and server settings (`server.env`, `.local/`) are gitignored.
- Content scripts and Gmail's MAIN world never receive provider keys, tracker tokens, server tokens or full settings. Extension storage is restricted to trusted contexts.
- Privileged runtime messages are accepted only from extension pages.
- All executable code ships in the package; no remote code.
- Tracking pixel and click routes are public by design; management APIs require a Bearer token (personal token, or a server access token scoped to one account). Click redirects only allow `http:`/`https:`.
- Email HTML is reduced to text before display in PigeonBox UI.
- The extension uses no Gmail API OAuth scopes and no undocumented Gmail write endpoints. A server uses the Gmail API only after a person connects Google and grants specific permissions, and keeps the refresh credential encrypted.
- A server serves only the accounts on its `ALLOWED_EMAILS` list.
- PigeonBox never sends email without the user: a server sends only messages approved in its approval queue.

The full analysis is in [docs/threat-model.md](docs/threat-model.md).

## Notes on tracking

Open tracking can be spoofed or blocked; events are signals ("Open detected"), not proof of reading. Suspected self-opens are hidden, not deleted.
