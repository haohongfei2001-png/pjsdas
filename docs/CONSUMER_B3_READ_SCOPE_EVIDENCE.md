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

- Local full suite: **330 files / 3618 tests passed** after the independent-review fixes; original per-test timeout/performance thresholds unchanged.
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
- Independent review found and corrected two P2 cases: contradictory broader
  refinements now explain the blocked expansion without removing existing
  restrictions; late read-state failures retain the original command ID and
  allow a safe detail-reopen/explicit retry without an automatic effect loop.
  Regression tests include the pure-title→broader quality sequence and a
  controlled late 503 after leaving detail.
- Real CI exposed two Search Scope timing failures: an editor opened before Auth
  ownership settled could remount closed, and one opened before the delayed
  authority read could keep an empty draft while the outside summary updated.
  Opening now requires owner admission. A pristine open editor follows the
  admitted profile and its save fingerprint; every edit/proposal/save freezes
  its baseline, preserving dirty input and rejecting competing remote saves.
  Controlled delayed-read browser cases cover all input paths and save failure;
  the original two-device reload assertion remains. Exact-head browser validation
  of this fix is pending. Existing version/owner cache guards are unchanged.
- The previously observed main B1 offline-first-action readiness flake is not
  fixed or reclassified by this change. Admission guards remain intact.
- The visual gate retains fixed pre-B1 `dbad72074299c8f585a9b13d5f4ae0b3a6b32116`
  and exact whole-page Today/Schedule hashes. Library keeps original unmodified
  whole-page evidence and exact heading/search/row-panel/total region hashes. Only the
  added Search Scope block, ninth query wrapping and removed Inbox link may
  differ: original eight query labels/styles, search style, panel geometry and
  the precise scope/toolbar vertical displacement are automatic assertions.
  A packed-flex layout oracle independently derives each button width/line/height
  from the original styles and text, and fixes search/row spacing to the reference.
  Negative tests reject a 600px blank filter region, shifted search, changed button
  width and line/panel gaps. The added block/query relocates the old buttons;
  real CI observed two ±1 corner pixels at desktop, 11 at 320/200%, and a
  fractional clip's neighbor strip at 390. These are retained in raw button and
  full-page evidence, not erased or reported as equal. Per the bounded acceptance
  decision, only these relocated controls use exact rendering/style/state plus
  geometry instead of image hashes. All computed properties (including font,
  color, border, padding, radius and shadow), both full pseudo-element styles,
  text/child markup, active/pressed/disabled/tab state are compared to the fixed
  reference, with negative mutations for these properties. Other region and
  Today/Schedule hash gates remain exact.
  Both runtimes execute original eight query, deadline ordering, 40/45 pagination
  and text-search regressions. Baseline Discovery preview and candidate Search
  Scope use separate explicit contracts. No baseline update, masking, image
  rewriting, arbitrary pixel tolerance or whole-Library exemption is used.

This is a candidate, not a release/deployment or a claim that all B3/A17 gates
have passed. Unsupported broad natural-language interpretation remains explicit.
