# Document tracking

Your PigeonBox server shares a private PDF through an opaque link for each recipient.
The dashboard and Gmail document panel use the existing document API; the
recipient opens the PDF in the same-origin PDF.js viewer. Ordinary email
attachments, Google Drive links, screenshots, printouts and reading outside
that viewer are not tracked. A recipient label identifies a link, not a
verified person; a forwarded link retains its original label.

## Quick sharing in Gmail

Choose **Track PDF** in the Gmail composer, or **Tracking → Track PDF…**,
then choose a PDF. PigeonBox uploads it privately and inserts the filename as
a viewer link in that composer. Downloads are allowed; the quick flow does
not require a recipient label, expiry, or watermark. **More options** opens
the document manager when those controls are needed. Nothing sends automatically.

Gmail's paperclip still attaches an ordinary file. Opening that attachment
does not produce an attachment-open receipt. Only opening the shared PDF in
the PigeonBox viewer can produce PDF activity; previously sent paperclip
attachments cannot be measured retroactively.

After the user sends, the extension associates owned viewer links with Gmail's
conversation receipt. It reads the links from the final draft, so saved and
reopened drafts work too. Associations are owner-only, retry-safe, and cannot
move a link to another conversation. Existing email-tracked viewer links can
also be matched through their recorded destinations.

The extension saves association receipts in trusted local storage before
delivery. Failed requests retry on the tracking alarm and after a service-worker
restart, including while email-open tracking is disabled. Receipts are bound to
the issuing API and signed-in account; switching accounts does not deliver
another account's receipts. This does not recover a Gmail send receipt that
never reached the extension, or observations lost when the reader closes an
offline viewer.

The email's tracking card shows **PDF opened** and **PDF downloaded** alongside
email activity. While the card is open, PDF activity refreshes every 15 seconds
independently of email-open and link-click counters. Sender previews and known
scanners remain excluded; a PDF view does not imply an email-open detection.

## Observations and accuracy

- Opening the HTML landing page creates no view. The recipient explicitly
  selects **Open document**, which creates an eight-hour server session.
- A view starts only after a page renders, paints, and becomes visible while
  the tab is focused. Blank placeholders and failed renders do not count.
- The most visible rendered page receives visible time. Coverage is measured
  relative to the viewport so tall pages work on mobile. Hidden/unfocused
  intervals and timer gaps over two seconds are discarded.
- Pages render near the viewport and release their canvases farther away.
  Returning to a page renders it again without adding a second page observation
  in the same session.
- Heartbeats carry deltas, with a 30-second ceiling per event. The server locks
  the session and bounds total time by its own elapsed clock. The reported
  duration is an observation of the viewer, not proof of attention or reading.
- The server assigns event timestamps and classification. The browser cannot
  choose its session ID, event class, or recipient record. IDs are scoped to
  the session. Database indexes allow one start and one observation per page
  in that session; retries do not double count.
- Failed deliveries retain their original payload and IDs. Visibility changes
  and unload use fetch keepalive; reconnect retries queued events. There is no
  disk persistence, so closing a browser during an outage may lose unsent time.
- Known scanners and authenticated sender sessions are excluded from all
  recipient counts and last-viewed timestamps. Scanner classification is a
  heuristic, not a guarantee that every automated browser is detectable.
- File fetches are separate from views. A permitted download from an
  interactive recipient session counts as a download, not reading. Direct
  unauthenticated fetches report file-fetch precision, without a human count.

## Sender protection

Use **Preview** beside a dashboard link. It issues a five-minute encrypted
proof bound to that owner and link, carried in the URL fragment and removed
before fetching content. The resulting session remains a sender session
through later heartbeats and downloads. Its credential is retained only in
the preview tab's session storage so a reload can resume that classification
for up to eight hours, even after the URL proof expires. Expired credentials
fail closed and require a fresh preview. An authenticated owner on the API
origin is also recognized automatically.
If the browser blocks tab storage, refresh requires a fresh preview; it never
silently opens a previous sender preview as a recipient.

The extension's Gmail bridge resolves document ownership at click time,
including Google redirect wrappers. Its signed-in server client calls
`POST /v1/documents/preview`; only an owner receives a preview URL. Recipient
and unknown links return `url: null`. Email tracker links whose resolved
destination is an owned document use the same preview flow; clicks refresh
preview proofs already cached in Gmail's displayed email copy. If refresh
fails, the cached preview stays protected and an expired proof fails closed.
The bridge never
returns account credentials or changes outgoing composer links. Opening a
copied link in a different, unsigned-in browser cannot identify the sender.

## Access and storage

Uploads are authenticated, entitlement gated, and streamed with a hard byte
limit even without a trustworthy Content-Length. PDFs are parsed before
storage, including compressed page trees; invalid/encrypted documents and
files outside the 1–500 page limit are rejected. Repeating an identical upload
is idempotent. Shared bytes are immutable; changed content requires a new
document and new links.

Storage requires a private Supabase bucket. The server checks bucket metadata
before writing or reading. Only token hashes are used for public lookup; the
owner's recoverable share token is encrypted with owner/link-bound AAD. Child
records have composite foreign keys that prevent cross-owner references.
Viewer sessions are server-only under RLS, expire after eight hours, and are
removed by retention sweeps. Logs use route shapes without link tokens.

Expiry and revocation apply to HTML, file, download, session, and event routes.
Event writes recheck policy inside their transaction. File responses recheck
policy after storage retrieval and are no-store, no-referrer, noindex, sandboxed
and non-frameable. Invalid/revoked/expired tokens receive the same unavailable
page. The active viewer clears its display on the next rejected heartbeat.
Revocation cannot erase a file or pixels already obtained by a recipient.

Deletion disables links before attempting storage removal. Failed cleanup
leaves a visible tombstone the owner can retry. Account deletion removes
private file paths before cascading database rows away. Analytics aggregate
in Postgres rather than loading an entire heartbeat history into the Worker.
Watermarks are visual labels in the viewer; disabling Download hides the
download action and denies its endpoint, but is not DRM.

## Activation and verification

Tracked PDFs are served when `DOCUMENTS_BUCKET` is set (with the database and Supabase service key the server already uses); the account then gets `cloud_documents`.

1. Set `DOCUMENTS_BUCKET` in `server.env` (for example `documents`) and run `npm run server:deploy`. It applies `20261008065925_document_tracking_sessions.sql` with the other migrations, creates that private Supabase Storage bucket if it does not exist (PDF only, `DOCUMENT_MAX_BYTES` or 20 MB by default), builds the viewer assets (`npm run assets -w @pigeonbox/api-worker`) and deploys the API Worker. It refuses an existing public bucket and never changes an existing bucket's settings. No browser storage policies are needed: uploads and reads go through the authorized API, using the server-only service key.
2. Document viewing runs on the API Worker; the email tracker protocol is unchanged.
3. Build/reload the extension (the deploy rebuilds it against your server).
4. Verify on your deployment with a controlled recipient and an owner:
   upload, share, open two pages, background/resume, download, sender preview,
   delayed sender click in Gmail, revoke, expired link, and delete. Confirm
   analytics and storage deletion, not only HTTP status.

To provision the bucket by hand instead (configuration, separate from application migrations):

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20000000, array['application/pdf'])
on conflict (id) do nothing;
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'documents';
```

Confirm `public = false` before deploying, and use the same name in `DOCUMENTS_BUCKET`.
Existing bucket settings are never silently changed by provisioning; the storage
adapter rejects a public bucket.

Local checks cover real compressed PDFs, ownership/RLS, replay, clock/page
bounds, cross-origin rejection, sender/scanner exclusions, expiry, revocation,
streamed-size enforcement, private-bucket enforcement, cleanup failures, and
account deletion. Browser tests use real PDF.js and the actual API router over
PGlite, with fake Google and in-memory storage. They cover dashboard upload,
recipient rendering, mobile geometry, lost acknowledgements, downloads and
sender preview in a separate signed-out context, including refresh. The
extension's unpacked-browser test also covers a fresh Gmail preview lookup
after a delayed click. These checks do not prove live Supabase Storage or
the extension already installed in the user's Gmail.

Verified locally on 2026-10-08, when the server still lived in a separate
repository:

- Server `npm run verify`: 486 tests in 45 files, typechecks and secret checks
  passed.
- Extension unit suite: 933 tests in 94 files passed. Full repository
  verification passed, including lint, typechecks, build and release packaging.
- The full server browser suite passed all 53 cases, including account, consent,
  dashboard and document flows.
- Four real PDF.js browser cases passed: recipient activity/retry/mobile/revoke,
  sender refresh with and without tab storage, offscreen canvas cleanup, and
  invalid upload cleanup.
- Four unpacked-extension Gmail browser cases passed: delayed document clicks,
  cached email-tracked document previews, and both existing long-lived email
  sender-tracking regressions. The latter exercises more than a minute of
  typing, autosaves, and sender pixel restoration.
- Both Worker bundles passed dry runs. Installed Gmail behavior and
  live owner/recipient testing remain separate from these local checks.

Research: [PDF.js rendering API](https://mozilla.github.io/pdf.js/examples/),
[Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API),
[Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
and [PDF-LIB parser API](https://pdf-lib.js.org/docs/api/classes/pdfdocument).
The storage adapter's REST behavior was also checked against Supabase's
[object upload](https://github.com/supabase/storage/blob/master/src/http/routes/object/createObject.ts)
and [object update](https://github.com/supabase/storage/blob/master/src/http/routes/object/updateObject.ts)
handlers.
