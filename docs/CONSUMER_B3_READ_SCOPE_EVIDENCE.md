# Consumer B3: new-discovery read state and confirmed Search Scope

Base: main `73e702d304bb44ab0f05e57825ed06aa16b31ec2` (merged #259).

## Approved contract

This implements the bounded remaining UI/read-state work in
[TODAYACTION_CONSUMER_CONVERGENCE_V1](TODAYACTION_CONSUMER_CONVERGENCE_V1.md)
§4.2–4.3, §6.2 and B3/A21–A22. The approved design PDF page 5 explicitly
previews “完整标题仅产品经理；排除 AI 产品经理、产品运营” for “只要纯产品经理”.
`titleEquals` implements that exact original-source-title condition, normalized
only for whitespace and case. Retrieval terms do not substitute for exclusions.

## Implemented boundaries

- All original eight category queries and deadline ordering remain; New is an
  orthogonal unread query, ordered by trusted first-add time, with existing
  company/title search and 40-row paging.
- `Opportunity.discoveryRead` is account-workspace metadata carried through the
  existing authoritative snapshot/delta path. Only new background Discovery or
  Gmail creation stamps it. Missing metadata means pre-cutover/user-confirmed,
  already viewed. Duplicate/source-refresh paths do not restamp arrivals.
- First-party `job_viewed` only marks an existing owned job after detail opens.
  It is idempotent, source-restricted and never creates tasks or schedule nodes.
  Connected UI uses the normal authenticated command/client/cache admission;
  local-only writes retain workspace leases. Rejected/unknown writes are not
  represented as saved. Retained rows preserve return focus until an explicit
  query/filter recomputation; a missing row falls back to the filter button.
- Search Scope is a small native modal with keyboard containment/Escape and
  return focus, saved-scope summary, and actual automation readiness. The old
  main-path Discovery Inbox and Settings multi-field preferences are removed;
  historical storage, commands and audit components remain compatible.
- Goal/refinement is a bounded deterministic proposal, not a claimed AI service.
  It supports explicit title lists, approved product-manager expansion, explicit
  title exclusion, exact-title conditions, added terms and explicit locations.
  Unknown intents are rejected without writing. Every proposal is visible and
  requires Save. Old profile assumptions are not silently adopted.
- Scope save checks the original raw profile fingerprint, in addition to normal
  authoritative CAS. `titleEquals` passes schema, profile/management save/read,
  worker scope projection and real quality filtering. Contradictory title
  conditions are rejected. Source titles are not rewritten.
- This change does not enable paid Discovery, change Gmail authorization, cron,
  ACLs, credentials, budgets, infrastructure or production data. No SQL migration
  is needed. Start remains visibly blocked on the existing budget prerequisite;
  explicit pause reuses the existing control. A17 genuine first/scheduled search
  remains pending, not replaced by fixtures.

## Validation status

- Local full suite: **329 files / 3607 tests passed** before final browser-test
  additions; original per-test timeout/performance thresholds unchanged.
- TypeScript/build passed. The generated release-identity build output is not
  committed as a claimed deployed identity.
- Added/updated actual Playwright journeys cover read cutover/count, no mark on
  focus, descending arrivals, paging, detail return focus, text filtering,
  saved scope/reload/bilingual labels, two-device authoritative commands and
  account switch with identical job IDs, and 1440/390/320 screenshots.
- Local Chromium **did not start**: the execution environment rejects its Unix
  socket during launch, including the authorized escalated retry. These are not
  browser PASS results or product failures. Existing CI Playwright containers
  must execute the journeys; screenshots/visual review and exact-head CI are
  still pending. No system security settings were changed.
- The previously observed main B1 offline-first-action readiness flake is not
  fixed or reclassified by this change. Admission guards remain intact.

This is a candidate, not a release/deployment or a claim that all B3/A17 gates
have passed. Unsupported broad natural-language interpretation remains explicit.
