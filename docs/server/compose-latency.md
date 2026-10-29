# Compose latency improvements

Implemented October 8–9, 2026. Measurements below come from the deployment that existed then.

## Baseline

An earlier live validation (October 8, 2026) observed a final compose request at 5,052 ms end to end, with successful provider calls around 2,925–3,335 ms. Those individual observations are not percentile benchmarks. The extension also waited 900 ms after typing before dispatching a check.

Superhuman [documents preparing Auto Drafts when mail arrives](https://help.superhuman.com/hc/en-us/articles/46005658551053-Auto-Reminders-Auto-Drafts), so a reply can be ready before the person opens it. That demonstrates advance preparation; its private inline-completion architecture is not documented by that source. PigeonBox already has background prepared drafts. Inline Brain suggestions still need the current phrase and fresh evidence, so the changes here reduce that interactive work.

## Changes

- Start a gated compose check after 450 ms of idle typing, saving 450 ms on an uncooldowned request. Keep the existing cooldown, per-minute/day ceilings and failure backoff.
- If the writer types the exact beginning of an in-flight, source-validated completion, display only its remaining suffix. Changed words, recipients, selection and factual warnings still invalidate it. No completion cache or automatic insertion is added.
- Use one RLS-scoped SQL statement for the daily, monthly and global budget snapshot instead of three serialized queries. This also benefits other intelligence operations using the shared budget check.
- Load existing memory state with one read instead of attempting an insert and encrypting a discarded hash key on every lookup. First-time initialization still reads the canonical winning key, and callers requesting a row lock retain it.
- Skip empty contact, interaction and commitment lookups when no relevant recipients/person or thread exist. Self facts, topic search and user notes remain available in a recipient-free compose window.
- Reuse entitlements within one Brain request instead of reading them again before judgment. No cross-request entitlement cache is added.
- Ask the model for a nullable advisory selection, with an index into a supplied source sentence. The server reconstructs that exact sentence and applies the existing relevance, confidence, grounding and post-inference checks. Completion quotes remain exact source text. Public API responses are unchanged.
- Validate only source types that the answer cites. A saved-memory-only completion now executes three post-inference statements (preferences, connected mailbox, memory revision) instead of ten. All exclusion, validity, revision, account and opt-in predicates remain in place.
- Use the existing request lifetime hook to settle successful inference accounting while sources are checked and the response returns. Worker `waitUntil` protects the work and database lifetime; Node/testing callers await it. Direct callers without a lifetime hook retain synchronous accounting. Recording failures emit content-free diagnostics.

The model, Standard processing tier, no-reasoning compose policy, one-attempt inference policy, response token ceilings, privacy and spend gates are unchanged.

Content-free compose telemetry now includes `loadMs`, `retrievalMs`, `preflightMs`, `inferenceMs` and `validationMs` beside total `latencyMs`. These measure selected phases; independent calendar work can overlap retrieval, so they are not an exhaustive partition of total request time. Prompts, suffixes and source quotes are still excluded from logs.

## Validation and remaining evidence

Regression coverage includes strict compact output, invalid advisory indexes and proof rejection; budget caps; delayed accounting; saved-memory source query counts; correction/forget/opt-out during inference; cross-user isolation; earlier dispatch; exact suffix consumption; changed-recipient and warning rejection; and delayed Chromium acceptance/undo/dismissal paths. The browser fixture now actually delays compose responses rather than delaying an unrelated overview request.

Passed (before the server moved into this repository): final complete server suite (539 tests, seven conditional skips); server types, vendor and secret checks; complete extension source verification (types, lint, tests, build and temporary package validation); all nine compose Chromium checks; both final Worker dry-run bundles; and whitespace checks. Memory changes and timing diagnostics also passed 33 focused database, compose and privacy regressions. No deployment was changed.

Real-provider latency and usefulness must be measured with the new prompt before claiming a particular end-to-end speedup. Neither the earlier five-second observation nor mock-provider tests establish the new live latency. A remaining model round trip can still take seconds. Further movement toward immediate suggestions would require a separately evaluated, opt-in preparation path or a faster inference service, with the same current-source checks.
