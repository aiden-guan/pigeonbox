# Tracking recovery in 0.8.1

Gmail can send quoted history and signatures as separate HTML body segments.
InboxSDK 2.2.29 exposes only the first segment to its request modifier, so
stripping pixels from that string alone leaves older messages' pixels in the
delivered reply. The extension's build applies a narrow, checked patch to the
bundled InboxSDK send processor: it strips PigeonBox pixels from every additional
segment when replacing the outgoing body. Text, ordinary images, links, segment
metadata and live drafts remain intact. Both current and legacy Gmail request
layouts have regression coverage against the installed SDK code. A changed SDK
boundary fails the build for review instead of silently dropping this safeguard.

Hosted tracking uses durable request acceptance, idempotent event processing and
database aggregation over complete event history. Activity polling uses a
persistent account-scoped cursor, advances after successful handling, and takes
a baseline on first use. Waiting shows pending send-receipt synchronization and
offers a retry. Existing receipts continue syncing when new tracking is disabled.

The 200-event timeline is a recent window; lifetime totals are separate.
Self-hosted older trackers without the cursor endpoint retain the legacy recent
snapshot fallback. No history completeness is implied by that fallback.

Self-hosted Supabase operators must apply
`20261016084347_tracking_reliable_stats_and_cursor.sql` before deploying the new
tracker. New service-role-only RPCs are `recompute_tracking_stats` and
`tracking_event_page`. The ingestion-order trigger serializes sequence allocation
until transaction commit. Keep database service credentials on the server.

The Worker accepts an optional `TRACKING_EVENTS` queue producer binding and
exports a queue consumer. Provision and bind a source queue with a dead-letter
queue before enabling it; configure bounded retries and inspect backlog/age and
dead-letter arrivals. Without that binding, self-hosted ingestion writes
synchronously and does not gain hosted queue durability. The source migration
does not alter a user's Convex deployment; that backend retains its own release
and verification requirements.

An image fetch can be cached or automated and does not identify a reader.
Ordinary Gmail attachments cannot be tracked. Use a PigeonBox PDF viewer link
for document activity; its browser journal can recover an offline session on a
later visit within eight hours, subject to storage and link/session validity.
Native Gmail scheduled sends may remain unconfirmed if Gmail does not report
the actual send. Queue/database outages together can still lose a request;
preserving recipient access takes priority over blocking an image or link.
