# PigeonBox product upgrade — engineering report

Verification date: 2026-10-01. These changes are local and undeployed. No commit,
push, real email/invitation send, subscription cancellation, credential
revocation or account deletion was performed. The public checkout arrived with
popup, runtime, settings and development changes; that work was preserved. The
private Cloud checkout arrived clean. Git's combined diff includes inherited work.

## Changes made

| Area | Result |
| --- | --- |
| Public extension | Continuous-work Cloud framing; capability-aware navigation; Overview / Approvals / Activity; unified Ask; briefing readers; Shadow creation/review; automation outcomes; contacts; PDF upload/link creation; contextual thread/calendar/relationship intelligence; Gmail document action; persistent mode; command palettes; scoped onboarding and Settings |
| Cloud backend | Read-only, bounded overview aggregate; expose existing document creation through the public contract; binary-upload CORS; sanitized optional operational reporting and scheduled queue gauges |
| Cloud web | Existing overview gains recent-work, briefing and automatic-work summaries; independent failures retain useful sections |
| Shared contract | Canonical overview request/response and route; canonical document-create route; validated binary PDF client; public changes synchronized through vendor:sync and verified by vendor:check |
| Testing | Real unpacked MV3 extension in Playwright, isolated profiles, controlled Gmail/API fixtures, CI traces/screenshots; new transport, sender-boundary, analytics, aggregate and privacy regressions |
| Observability | Disabled unless configured; fixed numeric operational metrics only; no raw exceptions or content exported; bounded asynchronous Worker reporting |
| Design system | Shared surface, accent, spacing and motion tokens; copper/dark hierarchy; focused keyboard interaction; stateful mascot; reduced-motion and static idle states; lossless WebP sprites |

See [the inspection map](product-upgrade-map.md) for package boundaries and reused
Cloud APIs, and [the analytics specification](../product-analytics.md) for the exact
local event schema. Private implementation remains in pigeonbox-cloud.

## New product flows

- **New user:** Welcome → Local/Cloud choice → setup for that choice → optional
  tracking → ready. Local comes first. Cloud requires explicit consent, sign-in
  and Google connection. The preview is restrained and dismissible; unavailable
  builds do not present broken connection actions.
- **Cloud home:** One overview request supplies sync health, work since the last
  visit (bounded to 30 days), prioritized Focus items, latest sourced briefing and
  automatic work. Counts use stored facts. Current approval counts and lifetime
  rule totals are distinguished from recent-work counts. Failed sections remain
  visibly unavailable; successfully loaded or stale sections remain usable.
- **Ask:** One product destination dispatches to the selected execution mode.
  Scope, coverage and sources stay visible. Cloud loading uses a generic honest
  preparation state. A failed Cloud request never invokes Local or another
  provider. Palette questions submit once after opening Ask.
- **Threads:** State, reason, next action, commitments, follow-up and prepared
  variants have a clearer hierarchy. Preparation time is reported truthfully.
  Optional relationship and calendar context use existing read APIs and Cloud
  preferences. Source links select the owning Gmail account. Draft and
  availability insertion change compose content without sending.
- **Rules:** Natural-language compile exposes actual triggers, conditions,
  actions, autonomy, warnings and approval requirements. Editing invalidates the
  preview. Creation saves in Shadow Mode; Correct/Wrong review uses the existing
  service. Activation stays in the Cloud management flow.
- **Documents:** Track with PigeonBox opens the document workflow for the target
  compose. PDF creation/upload is followed by recipient, expiry and download
  settings; the resulting link is inserted or copied. Viewer metrics show only
  observed data. No send action is introduced.
- **Activity:** Waiting, due follow-ups, selected-thread engagement, audit and
  automation outcomes retain attribution caveats and sender-open suppression.
  Full cross-thread activity, Calendar management, sequences, teams and API/MCP
  use capability-aware links to their specific Cloud web sections.
- **Settings and popup:** Settings separates execution, AI, Inbox, Tracking,
  Cloud, Personalization, Privacy and Advanced. Cloud preferences remain server
  owned. Clearing Local data requires confirmation and leaves Cloud untouched.
  Popup provides compact status, aggregate work and the main actions.

## APIs added or changed

| API | Contract / behavior |
| --- | --- |
| `POST /v1/overview` | `CloudOverviewRequest` / `CloudOverviewResponse`; generatedAt/since, nullable accounts/work/focus/latestBriefing/automatic sections and explicit unavailable sections; server entitlements and RLS enforce access |
| `POST /v1/documents/create` | Exposes existing document creation as a validated DocumentSummary; requires documents capability |
| Existing document content PUT | `documentUploadPath(UUID)` and authenticated client upload; fixed API origin/path, PDF header/type, 20 MB bound, timeout, redirect rejection, one auth refresh and validated response; CORS includes PUT |
| Extension message routes | Privileged Cloud calls/uploads/link creation restricted to trusted extension pages; content integration receives scoped read-only thread/context data through the worker |

Overview sections use separate user-scoped reads and preserve partial failure.
The endpoint does not enqueue jobs, generate drafts or run AI. Existing briefing,
rule, automation, contact, calendar, approval and tracking services are reused.

## Architecture changes

Cloud message handling was extracted from background orchestration into
`background/cloud/handlers.ts`. Gmail palette lifecycle and document compose
integration have separate modules. Cloud sections are separate lazy-loaded
surfaces with a lightweight common API helper. Settings primitives and Cloud
preferences are extracted; tokens, Cloud layout and mascot motion have scoped
styles. Existing tracking and AI modules remain in their established boundaries.

Product state listens to trusted storage changes, ignores stale refreshes and
cleans up listeners. Session/origin changes invalidate cached thread intelligence
and remount account-bound Cloud state. Google connection completion uses an
initiated-flow flag plus actual connection data refreshed on focus, without a
timer. Cloud overview fetches on entry/explicit refresh rather than polling.

Cloud vendor provenance records synchronization from public HEAD `b1fd7bdc09c7`
with uncommitted public changes. This is a local synchronized snapshot, not a
claim that a published public commit contains the new contracts. Re-sync and
verify provenance after committing the canonical public changes.

## Verification results

| Repository / check | Result |
| --- | --- |
| Public npm ci | PASS; lockfile install; audit caveat below |
| Public check:repo / check:versions | PASS |
| Public typecheck / lint | PASS |
| Public unit tests | PASS — 571 tests in 59 files |
| Public build / package | PASS |
| Public extension Playwright | PASS — 14 tests, 22.7 seconds |
| Cloud npm ci | PASS; zero dependency advisories reported |
| Cloud vendor:check / check:secrets / typecheck | PASS |
| Cloud unit tests | PASS — 225 tests in 25 files |
| Cloud browser tests | PASS — 8 tests |
| Cloud bundle:workers | PASS — both production Worker configurations bundled with deployment dry-run |
| Cloud acceptance | PASS — repository verification, browser suite and dry-run bundles |
| Live provider eval | BLOCKED — eval:live exits 2 without real CLOUD_AI_PROVIDER, CLOUD_AI_BASE_URL, CLOUD_AI_API_KEY and CLOUD_AI_PRIMARY_MODEL |

Playwright loads the built extension and its real service worker, client,
content integration and storage. It exercises Local independence, mode reload,
overview loading/disconnection/partial failure, Ask loading/sources, Gmail SPA
lifecycle, prepared variants/insertion, Shadow creation, PDF upload/link creation,
palettes, outbound tracking, placeholder cancellation and reduced motion.
Temporary builds omit the developer's tracker config, and each browser profile
is isolated and removed after use. CI retains failure traces/screenshots.

The permission fixture tests direct-gesture declared access and rejection of
undeclared access. Existing unit tests cover denial; a human cancelling Chrome's
optional permission prompt remains a live manual check. The controlled tracking
composer uses production transformation/decision modules with a test SDK harness;
it does not claim to prove real Gmail's outbound MIME or personal account flows.

Release package: `release/PigeonBox-v0.3.1.zip`, 53 files, 8,874,623 bytes,
SHA-256 `e00fbe3fa4a9221c71c031c3c000aae3cc6b697a45839be07cc51274a546df26`.
Source maps, developer tracker config, browser fixtures and redundant PNG sprites
are absent. Version and production endpoint defaults remain unchanged.

## Performance and visual evidence

The [420 px overview screenshot](assets/product-upgrade-overview.png) and
[full briefing reader](assets/product-upgrade-briefing.png) use synthetic data.
They were visually inspected; the browser suite asserts no horizontal overflow.
Onboarding was also inspected visually. Reduced-motion testing confirms the
mascot loop stops. No large continuous blurred-layer animation was introduced.

[Synthetic timing artifact](assets/product-upgrade-fixture-performance.json):
overview setup to ready **323 ms**; Ask **822 ms**, including the fixture's 300 ms
response delay; Gmail navigation plus thread mount **445 ms**; SPA route and
single-companion check **11 ms**. These include fixture/browser orchestration,
are single-run measurements, and are not live Gmail or provider benchmarks.

Optional Cloud screens are lazy chunks, approximately 2.55–8.80 kB; the sidepanel
entry is about 44.04 kB (12.87 kB gzip). Lossless sprites shrink from 1,148,078 to
863,806 bytes, about 25%. Existing InboxSDK/transformers large-chunk warnings
remain. Real Gmail content-load cost, provider latency and sustained animation
CPU need a production-equivalent profile; this work does not invent those figures.

## Focused security and privacy review

PASS in code review and regression fixtures: worker-only privileged transport,
sender trust/capability checks, schema validation, fixed-origin/path uploads,
account-bound source navigation, safe section deep links, explicit consent,
Shadow defaults, placeholder blocking, unchanged approval policy and no implicit
provider fallback. Read-only content handlers reject mutation calls; tests cover
the new sender and upload boundaries. Cloud entitlements remain server enforced.

Operational output has a fixed metric schema with finite bounded values. It omits
exceptions/stacks, URLs, query strings, headers, cookies, addresses, IDs, tokens,
mail, prompts and generated content. Unknown routes and document/link paths are
masked before local operational logging. Canary tests include a thrown exception
whose name contains a secret. Queue health measures dead jobs, oldest due job,
expired leases, lease-loss history and sync lag. API/tracker reporting uses
Worker waitUntil and provider failure is absorbed.

Product analytics is opt-in, local-only, enum/metadata allowlisted and bounded.
No external product analytics provider is configured. The automation_activated
event is reserved but is not emitted by an extension activation path, because
activation remains in Cloud management.

**Remaining dependency findings:** public npm audit reports five tooling
advisories (four moderate, one high), involving Vitest/@vitest/mocker and the
Wrangler/Miniflare/undici chain. A broad/major toolchain upgrade was not forced
into this change. These findings require maintenance before claiming a clean
dependency audit. No failing product regression remains in the executed suites.

## Production gates and precise manual verification

Local PASS is separate from live PASS. Prior dated cron/backfill/dead-job evidence
in Cloud production docs is preserved; it does not verify this undeployed patch.
Use controlled tester accounts, a controlled recipient and Stripe test mode.
Sending, revocation, deletion and other consequential live actions require the
operator's explicit authorization.

| Gate | Local evidence | Live status and procedure |
| --- | --- | --- |
| Duplicate Gmail push | PASS — existing duplicate delivery/sync regressions | BLOCKED / MANUAL: deliver the same real Pub/Sub notification twice; verify cursor, messages, jobs and effects remain idempotent |
| Tracking lifecycle | PASS — existing attribution/proxy/quoted/reload/multi-recipient unit fixtures plus controlled outbound browser flow | BLOCKED / MANUAL: send controlled MIME through real Gmail; test recipient open, immediate proxy, sender self-open, reload, quoted pixel and multiple recipients; inspect classification without claiming exact identity |
| Draft / approval semantics | PASS — grounding/safety/idempotency/reject tests and insertion/placeholder browser flow | BLOCKED / MANUAL: use a real synced thread; inspect sources, block unresolved placeholders, reject with no effect, approve a controlled send once and repeat the same approval to prove no duplicate effect |
| Ask semantics | PASS — sources/coverage and existing grounded research/injection fixtures | BLOCKED / MANUAL: ask known questions across granted accounts/context; resolve each source, check missing coverage and test hostile mail instructions as data |
| Stripe lifecycle | PASS — existing duplicate/order/idempotency regressions | BLOCKED / MANUAL: test checkout, webhook, entitlement, portal and cancellation; replay duplicate/out-of-order/retry events in Stripe test mode |
| Google recovery | PASS — existing revoke/reconnect/disconnect regressions | BLOCKED / MANUAL: revoke a throwaway credential, observe needs_reauth, reconnect and verify a fresh sync/cursor progresses |
| Cloud deletion | PASS — existing cascade/API/migration fixtures | BLOCKED / MANUAL: delete a throwaway Cloud profile; verify credentials, derived data, documents and jobs cascade while Local browser data remains |
| Live AI eval | No mock substituted; command reports missing configuration | BLOCKED: supply real production-equivalent provider settings and run eval:live; preserve actual metrics/output, and label unexercised cases N/A |
| Operational collector | PASS — payload scrubbing, unsafe-URL rejection, failure absorption and queue-gauge tests | BLOCKED / MANUAL: configure collector/secrets, deploy, trigger a controlled failure, verify received numeric payload/alerts and scheduled gauges, then restore healthy behavior |
| Gmail document action / permissions | PASS — canonical upload/link transport, controlled insertion/no-send and permission boundary | BLOCKED / MANUAL: exercise the real InboxSDK compose button in multiple composers, confirm exact target insertion, viewer observations and optional-permission cancel/grant |
| Deployment readiness | PASS — vendor/secrets/acceptance/package/dry-run checks | MANUAL: commit canonical public work, synchronize vendor provenance, select production build endpoints and release config, then deploy and perform these live gates |

No live gate above is marked PASS and no live failure is inferred from missing
credentials. FAIL applies to the outstanding public dependency audit findings.

## Remaining work

Complete the listed live gates and configure the external operational collector;
maintain the vulnerable public development toolchain; measure real Gmail/provider
performance and reduce inherited large bundles as warranted. Full management for
Calendar, sequences, team, API/MCP and activation intentionally uses the existing
Cloud web control plane. External product analytics collection is not configured.
Subjective first-time comprehension within ten seconds needs a human usability
check; visual inspection and functional fixtures do not establish that timing.
