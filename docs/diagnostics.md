# Extension diagnostics

Server logs and optional error tracking only see what reaches your PigeonBox server. Failures before that (InboxSDK not loading, Gmail selectors breaking, the service worker restarting, a compose check that never left the extension) are recorded by the extension itself, in `apps/extension/src/background/diagnostics.ts`.

## Where it goes

Nowhere. Events live in `chrome.storage.session` (cleared when the browser closes), capped at 40. The only way out is **Settings → Advanced → Copy diagnostics**, which puts a plain-text summary on the clipboard for the person to paste into a bug report. There is no network sink. Adding one would be a separate, opt-in decision covered by the [privacy policy](../PRIVACY.md).

## Event schema

Every event is rebuilt from allowlisted values by `sanitizeDiagnostic` when it is recorded and again when it is read.

| Field | Type | Values |
|---|---|---|
| `minute` | integer | Minutes since the Unix epoch (coarse on purpose) |
| `component` | enum | `service_worker`, `cloud_state`, `cloud_request`, `compose_check`, `remote_config`, `gmail`, `tracking` |
| `code` | string | `^[a-z][a-z0-9_]{0,39}$`: a server error code (`unsupported_protocol`, `network`), a compose status (`none`, `notice`, `disabled`, `unavailable`), or an event name (`started`, `restarted`, `inboxsdk_failed`, `selector_issue`, `malformed`) |
| `outcome` | enum | `success`, `failure` |
| `duration` | enum, optional | `lt_100ms`, `lt_500ms`, `lt_2s`, `lt_8s`, `gte_8s` |
| `requestId` | string, optional | A server request ID (`req_…`), which matches server logs. Never a Gmail ID |

Successful events are sampled at about 1 in 10, except service-worker starts. Failures are always kept.

Recorded today:

- `service_worker`: `started` / `restarted`, once per worker start.
- `cloud_state`: the outcome of each account-state refresh, with the error code on failure.
- `compose_check`: the status of each real-time check and how long the worker took. Never the clause or the advice.
- `remote_config`: `ok`, `unavailable` or `malformed` for each config fetch.
- `gmail`: `inboxsdk_failed`, `inboxsdk_loaded` and `selector_issue`, once per change rather than per report.

## Copied report

The report adds a snapshot of state, all enums, numbers, booleans or versions:

- extension version and build (`release` or `source`), Chrome major version, Local or server mode;
- server status, signed in or not, minutes since the last successful server response, update state and minimum version, maintenance notice;
- protocol version, remote config source (`default`, `remote`, `last_known_good`), revision, age and last error;
- compose checks: the last known preference (`on`, `off`, `unknown`) and any remotely disabled compose features;
- tracking on or off;
- Gmail integration, InboxSDK and DOM status, and how many Gmail account slots PigeonBox has seen (a count, never which);
- service-worker starts this session and uptime;
- the last error and up to 15 recent events.

## Never collected

Email bodies, subjects, recipients, senders, any email address, names, draft text, Ask questions, memory text, source snippets, Gmail thread or message IDs, URLs, access or refresh tokens, OAuth credentials and API keys. `diagnostics.test.ts` feeds such values into every field and checks that none comes out.
