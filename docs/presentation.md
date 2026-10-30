# Repository presentation evidence

The root README presents PigeonBox as a Gmail extension with local AI and an optional server you run yourself. This repository contains both the extension and the server. The claim map below was recorded in the October 19, 2026 presentation pass and updated when the project became fully self-hosted.

## Claim map

| README claim | Implementation | Verification or boundary |
| :--- | :--- | :--- |
| Local features do not need a server | [capability resolution](../packages/core/src/index.ts) | [core tests](../packages/core/src/core.test.ts) |
| Server errors do not choose another provider | [provider router](../apps/extension/src/background/ai/provider-router.ts) | [router tests](../apps/extension/src/background/ai/provider-router.test.ts) |
| Gmail content scripts receive limited privileges | [message gateway](../apps/extension/src/background/messaging.ts) | [messaging tests](../apps/extension/src/background/messaging.test.ts); this is not a complete security guarantee |
| Credentials are tied to their destination | [credential updates](../apps/extension/src/background/settings-credentials.ts) | [credential tests](../apps/extension/src/background/settings-credentials.test.ts) |
| Search reports its local corpus | [lexical index](../packages/search/src/index.ts) | [search tests](../packages/search/src/search.test.ts); no claim of full-mailbox coverage |
| Importance can learn from local behavior | [importance model](../packages/mailbox/src/importance.ts) | [importance tests](../packages/mailbox/src/importance.test.ts); no accuracy benchmark claimed |
| Tracking can use your own server's tracker | [settings types and defaults](../packages/shared/src/index.ts), [background orchestration](../apps/extension/src/background/index.ts) | Depends on a deployed server, the account being on its access list, and the server's availability |
| Tracking accounts for sender/proxy evidence | [tracking lifecycle](../packages/tracking/src/lifecycle.ts) | [regression matrix](../packages/tracking/src/regression-matrix.test.ts); observed requests remain probabilistic |
| Tracked PDFs (server) are separate from ordinary attachments | [compose document integration](../apps/extension/src/content/compose/documents.ts) | [browser fixture](../tests/browser/compose-documents.spec.ts); viewer/backend availability needs separate acceptance |
| Screenshots show the extension UI | [capture helper](../scripts/capture-readme.mjs) | [provenance and capture recipe](../assets/readme/README.md); synthetic data and server responses |
| Verification covers the source and package | [verify pipeline](../scripts/verify.mjs), [CI](../.github/workflows/ci.yml) | [dated local verification](VERIFICATION.md); browser and live checks are separate |

## GitHub surfaces

No repository metadata, topics, branch protection, Pages settings, or social preview was changed in this pass. Suggested owner-applied metadata:

- **Description:** Gmail workspace for local inbox triage, thread briefs, replies, and tracking, with an optional self-hosted server. Manifest V3, on-device AI, Ollama, and BYOK.
- **Topics:** `gmail`, `chrome-extension`, `manifest-v3`, `local-first`, `webgpu`, `email`, `typescript`, `ollama`.
- **Website:** Set only after confirming the intended product URL and its current behavior.
- **Social preview:** Capture the current extension with synthetic mail, frame at 1280 × 640, and label the displayed execution mode. The existing screenshots have their own documented aspect ratios and are not a social preview upload.

The original presentation checkout diverged from `origin/main`: three local commits and seven remote commits after fetch. Publication uses an isolated checkout of `origin/main` at `c5bd90f`, retaining the remote dependency upgrades and settings fix while leaving the three local feature commits in the original checkout. Dependencies, verification, and captures were refreshed against that publication source. Setup instructions point to `.nvmrc` so they follow the checked-out source's Node.js requirement.
