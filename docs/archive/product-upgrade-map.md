# PigeonBox product upgrade implementation map

## Inspected boundaries (2026-10-01)

Public checkout: `EmailApp` (repository `aiden-guan/pigeonbox`). Private checkout:
`../pigeonbox-cloud`. The public checkout arrived with popup/runtime/settings/
preview changes; preserve those. Cloud arrived clean. No deployment, push,
subscription cancellation, real send, revocation or deletion is authorized here.

The extension owns Gmail integration, UI and local execution. `core` resolves
mode/capabilities; `shared` owns settings/messages; `gmail` owns adapters and
draft placement; `mailbox`/`search` own the local index; `agent` orchestrates AI;
`tracking` owns attribution and self-open suppression. Only background
orchestration calls `cloud-client`, which validates `api-contract` schemas.
Content scripts cannot read trusted storage or call privileged Cloud routes.
Cloud sessions are PKCE, single-flight refreshed, and bound to their API origin.
Local never depends on Cloud health and Cloud AI never silently falls back.

Cloud owns Workers, auth, billing, encrypted derived data, Google access, durable
jobs, policy and the web control plane. Every SQL read/write uses `asUser`/RLS.
Capabilities are server entitlements intersected with configured infrastructure.
Tier 3 sends/invitations need explicit approval; new action rules start in Shadow
Mode. Canonical public packages are synchronized using `scripts/sync-public.mjs`
and checked with `vendor:check`; vendored files are never edited by hand.

## Existing surfaces and APIs

| Area | Existing implementation | Upgrade path |
| --- | --- | --- |
| Side panel | Cloud approvals, Focus, separate Ask; Local Inbox/Ask/Waiting | Overview / Approvals / Activity, one product Ask |
| Thread card | Read-only cached ThreadIntel, variants, promises, follow-up | Clear hierarchy, source access, optional contextual calendar/relationship reads |
| Shell | Shadow DOM, placeholder guard, command palette already exists | Extract palette lifecycle; contextual capability-filtered commands |
| Setup | RunModePanel, CloudConnections, AiConnect, ProfileFields | Continuous-work framing and direct Cloud setup with explicit consent |
| Cloud management | `/app#briefings`, `#views`, `#automations`, `#contacts`, `#documents`, `#team`, `#developers`, `#sequences`, `#preferences`, `#connections` | Specific safe deep links; lightweight extension readers/editors |
| Briefings | list/get/generate/meetingBrief; encrypted sourced items | Latest overview preview and reader; generation by gesture only |
| Smart Views | compile/save/results/shadow/review/activate/history | Show states/matches, compile preview, save in Shadow, Correct/Wrong |
| Automations | compile/save/runs and policy tiers/autonomy | Explain compiled actions, Shadow save, recent outcomes |
| Documents | Private PDF storage, binary PUT, per-recipient links, observed page metrics | Public create contract and validated binary client; Gmail compose link insertion |
| Activity | followUps, auditList, threadSignals, documents | Waiting and engagement with attribution caveats |
| Preferences | Existing Cloud writing, scheduling, follow-up, safety preferences | Source-of-truth controls; Local profile stays Local |

## Contract additions planned

`cloudOverview`: bounded read aggregate with explicit window, exact counters,
sync state/coverage, prioritized Focus items, latest briefing, views/automation
activity and section-level failure states. Capability-filter optional sections.
`documentCreate`: expose the existing creation service; use the existing bounded
binary upload path rather than duplicating storage or putting PDF data in JSON.
Read-only contextual thread enrichment remains service-worker mediated and
capability checked. No content-script mutation API.

## Baseline and acceptance

Locked dependency installs succeeded in both repositories. Public unit suite
passed; Cloud baseline: 23 files / 218 tests passed. Architecture, privacy,
contracts, session/messaging, vendor sync, server routes, entitlements, configured
capabilities, browser tests and production docs inspected before implementation.

Current deployment docs record prior cron/backfill/new-mail recovery evidence.
They explicitly leave duplicate real push, recipient tracking lifecycle, draft/
approval semantics, Ask semantic accuracy, Stripe full lifecycle, revocation/
reconnect, throwaway deletion and live safety evals incomplete. Preserve dated
evidence and incidents. Local fixtures cannot close those gates.

## Work sequence

1. Foundation: metadata/copy/discovery/unified Ask.
2. Overview contract/client/server and resilient extension sections.
3. Thread context, prepared work and grounded source links.
4. Briefing, Smart View, automation, document and activity workflows.
5. Palette, mascot, motion and non-happy states.
6. Browser regressions, safe analytics/observability and scoped refactors.
7. Full verification, security/performance review and precise live-gate report.

Implementation status and verification evidence will be recorded in
`product-upgrade-report.md`.
