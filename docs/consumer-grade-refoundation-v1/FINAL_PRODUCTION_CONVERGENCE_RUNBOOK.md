# Final Production Convergence Runbook

Purpose: close the remaining PJSDAS Consumer-Grade Refoundation v1 production gates with one batched exact-SHA deployment after all production-independent engineering is stable.

This runbook does **not** authorize release publication, new OAuth permissions, paid services, synthetic recruiting email, or real recruiting external actions.

## 0. Candidate selection

Use GitHub remote `main` as the only code fact source.

The final candidate is the newest stable integrated main SHA after all production-independent CGR-04/CGR-05 work is exhausted. Do not select a historical product-runtime SHA merely because the product code is unchanged; production health, frontend manifest and certification workflows are exact-repository-SHA contracts.

Before deployment:

- no open runtime defect PR;
- exact-main CI/build/security PASS;
- exact-main Browser E2E PASS for the latest product-runtime change;
- required non-production accessibility/reliability evidence already recorded;
- no unresolved safety/integrity regression.

## 1. Exact deployment preflight

After provider capacity is available, deploy the selected exact main SHA once.

Require both:

- `/api/health` -> `release.commitSha == <candidate SHA>`, `workspaceAuthority == transactional`, required authenticated MCP tool surface present;
- `/release-manifest.json` -> `commitSha == <candidate SHA>`.

If either origin reports another SHA, stop certification. This is deployment propagation, not a product PASS.

Then rerun the existing production self-test/release-gate path. Publication must remain disarmed.

## 2. Web / core production journeys

Rerun the existing frozen production canaries against the same exact SHA:

1. CGR-02 synthetic command canary for Today authoritative save, receipt, second-session propagation and Undo.
2. CGR-03 production browser canary for Opportunities list/detail/deep-link, action/Undo and Web capture -> DecisionRequest -> bounded resolution -> second-session readback.

Use only short-lived synthetic identities and verify cleanup.

A historical PASS on an older SHA is evidence of architecture maturity, not final certification of the newer integrated runtime.

## 3. Gmail current-live source certification

Do not send a synthetic recruiting email merely to manufacture a PASS.

Use the first naturally available real recruiting Gmail source record after the repaired exact SHA is deployed, or another already-authorized real recruiting record that the production transport legitimately receives after deployment.

Verify, using bounded metadata and only the minimum message content needed for source correctness:

1. Gmail transport is healthy: history cursor present, no incomplete page/history/message continuation unless actively processing, no latest transport error.
2. The source record is accounted exactly once.
3. Interpretation produces either:
   - one correct bounded authoritative update, or
   - one concrete DecisionRequest when target/occurrence is genuinely ambiguous.
4. No unrelated Opportunity choices are offered for an identity-free target.
5. Conditional text such as “if already completed, ignore” or “otherwise cannot enter the next interview” does not create completion/interview facts.
6. UI projection in Today/Opportunity/Decision surfaces matches the authoritative result.
7. Replay/redelivery does not duplicate the business fact or DecisionRequest.
8. A source/interpretation failure remains distinct from a normal unsupported attachment/link boundary.

If a real message reveals another defect, repair the earliest affected behavior and invalidate downstream source evidence before closure.

## 4. current-chat / MCP production certification

Run `.github/workflows/cgr04-production-current-chat-canary.yml` with `expected_sha=<candidate SHA>`.

Expected PASS proves, on one isolated synthetic account:

- real production `/api/mcp` transport;
- `semantic_intake` with `source.kind=mcp`;
- one ambiguity -> one DecisionRequest;
- no guessed mutation before resolution;
- second-session DecisionRequest projection;
- replay idempotency without authoritative revision advance;
- bounded `resolve_semantic_decision`;
- second-session authoritative result;
- verified cleanup.

The workflow explicitly reports that it does **not** certify a real ChatGPT host OAuth client. If a real current-chat connector is available at closure time, perform one non-consequential owner-input read/write check through that actual host transport and bind it to the same authoritative receipt. Do not invent that evidence when the host connector is unavailable.

## 5. PAIA capability truth

First query active delegated authorization grants.

If there is **no** active PAIA `semantic_intake` grant:

- PAIA is not an active production source;
- the CGR-04 production MCP canary must return `AUTH_FORBIDDEN` for `ingest_paia_input`;
- authoritative revision must not change;
- product/canonical language must not describe PAIA as currently connected or healthy.

This is truthful inactive capability evidence, not an authorized PAIA transport PASS.

If a real PAIA delegated grant exists:

- use one authorized owner-input record through the actual PAIA transport;
- verify transport -> Semantic Intake -> authoritative receipt/DecisionRequest -> UI projection;
- replay the same source record/version and verify dedupe;
- do not expand permissions or persist raw private owner text in ledger evidence.

## 6. CGR-05 final production convergence

On the same exact deployed SHA, reconcile:

- CGR-02/CGR-03 core production canaries;
- Gmail current-live result;
- current-chat MCP result;
- PAIA active/inactive truth;
- production self-test and security/release gates;
- no active routine whole-snapshot connected writer;
- no new critical integrity warning.

Existing non-production evidence remains valid unless a newly found production defect invalidates it:

- two-hour connected-session PASS;
- Chromium/Firefox/WebKit/mobile RC PASS;
- dense workspace/account isolation/cross-client/recovery PASS;
- keyboard/narrow/large-text PASS;
- real VoiceOver primary-route PASS;
- legacy-retirement audit.

## 7. Closure

Only after every applicable frozen gate is PASS:

1. create final CGR-04 production receipt and mark CGR-04 `COMPLETE / PASS`;
2. create final CGR-05 baseline receipt and mark `COMPLETE — STABLE CONSUMER-GRADE BASELINE`;
3. clear or close applicable deferred final gates with exact evidence;
4. mark package COMPLETE;
5. report release publication state separately;
6. stop.

Do not automatically start UU-08, UU-09, iPhone work, a new CGR phase, or unrelated feature development.
