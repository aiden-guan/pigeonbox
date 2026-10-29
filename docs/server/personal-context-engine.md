# Personal context engine

## Architecture audit and boundary

The existing server flow is Google push → metadata sync → versioned `thread.analyze` jobs → encrypted summaries, commitments, relationship events, structural writing profiles → indexed derived context and suggested drafts. Gmail bodies are read just in time through `thread-reader.ts`; Fast Recall is a separate opt-in encrypted excerpt store. The server uses `SqlDatabase.asUser`, `pigeonbox_app`, `app.user_id`, `app.protect_user_table`, the existing SecretBox, the existing pgmq job queue, metered inference and 768-dimensional pgvector. The extension already has a server client/AIProvider and an authenticated message bridge.

This change extends that flow in `packages/server/src/intel/memory/`. It introduces no provider, database, sync mechanism, contacts, commitments or writing profile replacement. Wire/client changes live in the shared workspace packages (`packages/api-contract`, `packages/cloud-client`), which the server imports directly. Local AI and search continue to work independently.

## Database

`20261002022655_personal_context_engine.sql` adds seven protected tables:

| Table | Content |
| --- | --- |
| `personal_memories` | Encrypted derived text/entity labels, keyed fingerprints, kind/category, confidence/importance, temporal validity, supersession, model and vector |
| `personal_memory_entities` | Keyed entity digests with attribution reliability; indexed exact entity lookup |
| `personal_memory_sources` | Owned account/thread/message references, timestamp and version; no evidence text |
| `personal_memory_state` | Encrypted random per-user digest secret, generation and learning cutoff |
| `personal_memory_blocks` | Content-free keyed forget tombstones |
| `personal_memory_exclusions` | Thread IDs excluded from automatic historical summary/excerpt context after forgetting |
| `personal_memory_extractions` | Content-free completed version/generation checkpoints |

All use existing user RLS. Composite memory ownership FKs and an invoker provenance trigger prevent forged cross-tenant entity/source pointers. Message/account/thread deletion cascades source rows; an invoker trigger removes uncorrected orphan facts. Corrected facts remain explicit owner-authored corrections. An active-only HNSW index matches the existing vector dimension/model checks; other indexes cover entity, source and active/category/concept lookups.

## Extraction, consolidation and time

Eligible versioned analysis enqueues `memory.extract` with IDs/version/generation only. The job rechecks account, feature, preferences, content version and completion checkpoint before reading bounded stripped Gmail text. Existing `runStructured` performs metered low-effort structured inference with Zod validation and one repair attempt. No expensive reasoning per keystroke is introduced.

Candidates must have exact own-words evidence, an exact participating email, high confidence/importance/usefulness, ordinary sensitivity, valid time scope and no invented detectable numeric facts. Deterministic policy rejects bulk mail, marketing, boilerplate, speculative claims, injection and secret/sensitive categories. Third-party mail cannot create instruction, preference or goal memories. The transparent score is importance × confidence × usefulness × entity reliability; minimum confidence is 0.8 and minimum score is 0.36. Expiry is anchored to the source timestamp: short logistics use seven days, other temporary/episodic facts thirty days when exact expiry is unavailable.

Keyed fingerprints include the attributed person, so identical wording from separate people does not merge. Repeated normalized facts consolidate source references and update confirmation/confidence only for new evidence, without reembedding unchanged text. Exact person/topic/attribute scopes permit supersession only on explicit newer correction language. Older backfills cannot replace current values. Superseded records remain inspectable. Corrected text is reindexed asynchronously through `memory.reindex`, after removing its old vector immediately.

Per-user state locks serialize persistence, correction, forgetting, purge, learning changes and disconnect. Generation changes plus source-time cutoff prevent pre-purge queued/in-flight work from resurrecting data. Completed content-version checkpoints make extraction replay cheap. No AI call occurs inside a persistence transaction.

## Memory pages (October 2026)

Facts belong to a **subject** instead of a recipient: `self` (the owner, one page across every inbox), one `person` (exact email), or one `topic` (a named project, course or organization). `scope_key` is the keyed subject digest and `subject_type` names the kind; `personal_memory_subjects` (`20261006120000_memory_subjects.sql`) holds each page's encrypted label and overview. Previously the scope was the counterparty, so "I'm a freshman at Berkeley" told to five people became five facts.

Writing is reconciliation, not append (the Mem0/ChatGPT pattern). `memory.extract` gives the model up to 40 KNOWN facts for the owner's page and the thread's participants as `kN | page | fact` lines, and the model returns `add`, `update` (ref) or `confirm` (ref). A confirm only adds a source and confidence. An update supersedes its target when newer, and becomes history when older. A handle the prompt never offered is dropped. For adds, a deterministic backstop merges into the nearest same-page fact at cosine ≥ 0.9, but only when numbers, months and weekdays match exactly (`sameSpecifics`, so "Oct 14" never merges into "Oct 16"). Policy now allows `goal`/`preference` facts only from the owner's own words about themselves. Person pages require the person on the message, and no fact may carry an email from outside the message. Owner facts drop recipient email entities, so they never surface as facts "about" whoever was emailed.

`memory.consolidate` is a debounced "sleep-time" pass: ten minutes after learning, or immediately when Memory is opened, with at most one queued per user. It (1) files facts written before pages, reworded without "X says", keeping the original wording whenever the grounding guard sees a changed detail; (2) merges same-page duplicates, moving every source and entity and never merging away a correction; (3) writes a 1–3 sentence overview for pages with three or more facts. It sends only changed pages, and single-fact pages need no model. A summary is shown or used only while every fact in `summary_memory_ids` is still active, so forget, correct, supersede, disconnect and Gmail deletion invalidate it with no extra bookkeeping. A correction also schedules an immediate rewrite.

Retrieval adds one compact `profile:self` item (the owner's overview, or their top six facts) in place of the individual facts it covers. Facts are labeled by subject ("About Professor Smith <…>:"). Ask receives the same overview as background. Real-time checks opt out (`profile: false`) because they compare individual facts. The dashboard Memory view is an index of pages (You / People / Topics) plus one page per subject, with mentions of other pages linked and search across every fact. `memorySubjects` (POST `/v1/memory/subjects`) lists pages; `memoryList` accepts `subject`.

## Unified retrieval and drafts

`getRelevantContext` forms a bounded cheap query from subject, intent, recipient and active text, then uses one existing embedding call. Failure/budget exhaustion falls back to exact entities and metadata. It combines:

- active, valid, confident personal facts via exact entity/current-thread and vector shortlists;
- encrypted current/prior summaries using participants, existing metadata FTS and existing search vectors;
- current/open recipient commitments;
- existing contact/company interaction counts and VIP status, encrypted contact/user notes;
- upcoming recipient calendar events;
- bounded encrypted Fast Recall excerpts only when enabled.

Exact recipient and current thread dominate slightly better unrelated vectors. Open loops, importance, confidence, query overlap and time decay also contribute. Episodic information decays faster than durable facts. Selection deduplicates text and caps results at 12 items and 4,000 conservative tokens (default 10/2,000). Queries/decryption are bounded; sources are loaded in one batch. Only selected facts update access time. Superseded/expired/forgotten source threads are excluded from automatic historical summaries/excerpts to prevent stale or forgotten values bypassing the fact filter. An explicitly selected thread remains working context.

The existing `prepareDraft` path used by manual, suggested and follow-up drafts receives this pool through `buildContextPack`; live scheduling availability and structural `resolveStyle` remain in place. The extension AIProvider `/v1/ai/draft` and follow-up path also use the same engine and style resolver under authenticated owner scope. Prompt priority is explicit current user preferences/instructions, current conversation, verified evidence, active loops/events, personal facts, learned style. Email context stays untrusted supporting data. Existing grounding checks the selected corpus, now also detecting unsupported chapter/midterm/room/section numbers. Prepared drafts retain source chips; generic draft responses include bounded provenance.

Retrieval runs on requested drafts/search submissions, not every keystroke. No cross-user or long-lived plaintext cache is added. Gmail source versions are checked against synced thread versions; current-thread mail and scheduling availability are still fetched just in time.

## Real-time Pidgy checks

`intel/compose-check.ts` and `intel/compose-context.ts` reuse this engine for one ephemeral unsent clause, under the same opt-in `memory.realtimeComposeChecks`. The shared local detector admits broader personal-context statements; the server independently derives their meaning. Exact retrieval/deterministic checks run first, then optional existing semantic indexes without a date/number prerequisite, then at most one small model relevance judgment with grounded extractive output. Live retrieval uses individual owner/person/topic facts (never the compressed profile), current mail, commitments, user notes, direct interactions and fresh calendar events. It keeps `recordAccess: false`, stricter source versions/forget exclusions and a budget of 8 selected items/1,400 conservative tokens. Source ownership/revisions and opt-in are checked after inference. The clause/query vector never becomes persistent content.

See [Ambient compose context](ambient-compose-context.md) for the complete pipeline, cost/privacy bounds, calendar migration, validation and limitations. Draft/search retrieval retain their existing defaults.

## Controls and privacy semantics

Authenticated shared contract routes follow existing POST conventions: `memoryList` (query/category/history/pagination), `memoryGet`, `memoryForget`, `memoryUpdate`, `memoryPurge`. These routes require no capability; API-token/agent instruction access is not extended. The typed server client and extension background bridge validate both directions.

Both the dashboard and server-mode extension settings expose compact Memory views: learning toggles, categories, recent facts, source/freshness, correction, single forget, explicit search and typed bulk-forget confirmation. Fast Recall status is separate. No memory persistence happens in the extension. Local mode does not require server memory.

Defaults enable derived learning from received mail, sent mail and draft edits. Sent mail/edit toggles also gate existing structural writing learning. Turning learning off stops new personal fact creation and corresponding writing learning; saved facts remain usable until forgotten. It does not turn off independent summaries, commitments or relationships. Fast Recall retains its separate default-off/retention/delete-on-disable behavior.

Single forget removes the fact/vector/entities/source links and retains keyed forget markers. Supporting historical thread context is excluded from automatic draft retrieval; original Gmail is unchanged. Bulk forget clears personal fact data/checkpoints/blocks, rotates generation and excludes previously synced historical threads; future eligible communication can be learned. Connections, contacts, writing profiles and optional Fast Recall remain separately managed. The broader existing mail-data purge handles personal data and its control markers. Disconnect always removes account source pointers and excerpts, retains facts supported by another connected account, and removes uncorrected orphans even when thread metadata is kept.

Sensitive fact/entity text uses existing record/user/purpose-bound encryption. Entity/fact/concept keys use the existing HMAC helper with an encrypted random per-user key. Embeddings retain the same derived-vector privacy/access model as existing semantic search. Logs/usage/audit contain counts, IDs, safe codes and latency, never text/evidence/bodies; job payloads contain IDs and digests only. Privacy inventory includes all new user-visible fact/control data. Memory does not authorize sending or other autonomous actions.

## Files

- Added: `intel/memory/{types,policy,store,extract,reindex,rank,retrieve,manage,draft-context,memory.test}.ts`, migration, `testing/memory-fixtures.ts`, `evals/memory.test.ts`, dashboard `control/sections/memory.js`, this document. Existing shared vector encoding and summary decryption moved into `db/vector.ts` and `intel/thread-summary.ts` to remove import cycles, with compatibility exports retained.
- Server integration: analysis/jobs/queue, preferences/writing gates, search index/thread view helper imports, context pack/drafts/prompts, generic AI route/runner/policy, crypto purpose, privacy/disconnect, scoped control styles/navigation and browser fixtures/tests.
- Extension and shared packages: API contract memory/preferences/draft schemas and routes, server client management methods, AI/agent optional context selectors, authenticated extension bridge, settings Memory UI and UI/contract/client tests.

## Validation and rollout

The tests use synthetic Gmail and controlled imperfect inference while exercising real API routing, queues, encryption, PostgreSQL/PGlite, all migrations, vector operations and RLS. New coverage checks policy/expiry, attribution/consolidation, update/backfill, ranking/token limits, both draft paths/grounding, completed-job replay, purge cutoff, correction reindex, Fast Recall opt-in, Gmail deletion, source ownership, disconnect, UI controls and wire bounds. Existing suites cover sync/auth/tracking/search/relationships/commitments/automations and local providers.

Verified locally on October 1, 2026 (UTC October 2), when the server ("Cloud" below) still lived in a separate repository from the extension ("Public"). Several of these commands have since been renamed or removed; see [development](development.md) for the current ones.

| Command/check | Result |
| --- | --- |
| Cloud `rtk npm run typecheck` | PASS, production and test TypeScript |
| Cloud `rtk npm test` | PASS, 254 tests across 27 files, including migration/RLS and memory pipeline tests |
| Cloud `rtk npm run eval` | PASS, 26 offline eval tests across existing and new professor/recruiter/privacy/noise/update scenarios |
| Cloud `PIGEONBOX_BROWSER_PORT=8792 npm run test:browser` through RTK | PASS, 9 real-router Chromium flows, including memory source/correction/forget and mobile overflow checks |
| Cloud `WRANGLER_LOG_PATH=/tmp/pigeonbox-memory-worker.log npm run bundle:workers` through RTK | PASS, API/tracker production dry-run bundles; no deployment |
| Cloud `rtk npm run vendor:check` / `rtk npm run check:secrets` | PASS, synchronized upstream source and secret-safe scan including untracked files |
| Public `rtk npm run typecheck` / `rtk npm run lint` | PASS |
| Public `rtk npm test` | PASS, 584 tests across 62 files; new memory component/contract/client controls pass |
| Public `rtk npm run test:browser` | PASS, 14 Chromium extension flows including Local Ask while Cloud fails |
| Public `rtk npm run build` | PASS, all workspace packages, extension and tracker |
| New module Prettier and both `rtk git diff --check` checks | PASS; no whitespace failures |
| Runtime import graph check | PASS, no new memory module belongs to an import cycle after shared-helper extraction |
| Desktop/mobile screenshots | Inspected; initial editor/pagination hiding corrected, layout within viewport |
| Cloud `rtk npm run eval:live` | BLOCKED, explicit real provider configuration absent; no credentials recovered or production state changed |

Existing non-fatal build warnings concern chunk size, a static/dynamic agent import and Vitest's future configuration-loader default. Both checkouts remain uncommitted; inherited and concurrently edited work is preserved. During validation a concurrent popup hook/stylesheet/thread-panel update temporarily failed public checks; the final public run is green.

`npm run server:deploy` applies the additive migration before deploying the Workers and rebuilds the extension against them. The migration contains no historical migration edit or destructive existing-table change. Real-provider extraction quality still needs verification on your deployment; deterministic fixtures prove mechanics, not live-model recall/precision. `npm run server:eval` also runs the new scenarios and requires explicit real inference configuration.

## Remaining limits

Consolidation uses normalized identical attributed wording rather than speculative fuzzy merging. Sensitive-data filtering combines deterministic patterns and model classification, not a complete semantic DLP classifier. New facts are extracted from mail; existing calendar/notes/preferences/writing are retrieved directly rather than copied into the new table. Generic vague conflicts remain separately attributed claims. Source version checks rely on sync freshness; selective rereading of old high-value Gmail sources is not yet enabled. Search is semantic ordering with bounded recent/category fallback when embeddings are unavailable. Automatic historical exclusions can hide other useful facts in the same thread after forgetting; explicit current-thread access remains available. Real-time Pidgy checks run only on settled, locally gated clauses; their short answer cache lives in the extension's memory per compose window, never on the server or in browser storage. Existing separate contact/writing/Fast Recall privacy controls remain the way to erase those stores.
