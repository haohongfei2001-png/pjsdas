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

## Native raster diagnostic (not a relaxed image gate)

The unmodified Chromium 153.0.8010.12 / Playwright 1.63.0 runs retained stable
fixed-reference frames across four jobs. A separate diagnostic head captured
three consecutive native screenshots per state: all three matched within each
runtime, while the candidate still differed at a few rounded edges. Schedule
1440 had identical 40-element DOM geometry/computed styles/text; Today after
Settings at 390 had identical 81-element geometry/computed styles/text. Focus,
fonts, scroll, device scale and animation state also matched. Library descendants
only had the independently approved block displacement; their styles matched.

The next diagnostic uses one documented rendering switch identically in both
runtimes: `--disable-skia-runtime-opts`. Chromium's exact tested version defines
this as its baseline CPU path for web tests, and GoogleChrome's tooling guide
records it. It does not change the page, antialiasing policy, screenshot pixels,
baseline source or exact comparison threshold. Actual runtime version, configured launch arguments and all
raw repeats are retained. This is a rendering-path experiment, not a claim that
the failed comparisons have passed. No further flags will be stacked without
evidence. Sources checked 2026-10-17:
- https://github.com/chromium/chromium/blob/153.0.8010.12/content/public/common/content_switches.cc#L216-L218
- https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md#rendering--gpu

The first renderer experiment did not enter a page: the optional CDP command-line
probe requires `--enable-automation`, which this runner does not set. The probe
was removed rather than changing automation behavior just to observe it. The
same single-renderer-flag experiment is rerun with actual browser version and
Playwright's effective configured arguments recorded separately.

The single-switch experiment completed on run 38998988581. Every failing
before/after hash was identical to the default-renderer run; the flag therefore
had no effect on this discrepancy and was removed. The next bounded diagnostic
keeps the original gates and adds direct real-route captures plus html/body/root
size/background/compositing state, all DOM attributes and ordered CSS rules.
No additional flags or thresholds are introduced.

The root-state/direct-route diagnostic (run 38999617414) found exact fresh-route
Today/Schedule pixels, while the original navigation still differed. In both
failing main states the full html/body/root geometry, styles/pseudos and all
main DOM attributes/styles/geometry were equal. The next paired replay retains
the same user navigation but captures only native whole pages; the original
locator-capture path and every original gate remain intact. This distinguishes
capture-operation history from application navigation without altering DOM,
pixels, thresholds, or the fixed reference.

## Native compositor root cause and bounded visual environment repair

The separate, now closed, diagnostic PR #271 preserved three artifacts:
- Native paint records: https://github.com/haohongfei2001-png/pjsdas/actions/runs/39065481597/artifacts/12113231075
- Single-variable partial-raster experiment: https://github.com/haohongfei2001-png/pjsdas/actions/runs/39066078626/artifacts/12112917675
- One compact-confirmation profile: https://github.com/haohongfei2001-png/pjsdas/actions/runs/39065284317/artifacts/12112861826

Schedule1440 retained exactly one pixel from the preceding Library scope text;
Today390 after Settings differed at six rounded-edge pixels. The corresponding
current LayerTree command lists (84 and 102 commands) were identical between the
fixed reference and candidate, as were their native replay PNGs. Actual native
screen PNGs still differed. This locates the discrepancy after current paint
recording, in the compositor's history-dependent raster path rather than changed
current DOM drawing instructions. Replay images are diagnostic evidence only;
they do not replace screenshots in any gate.

Chromium 153.0.8010.12 explicitly reads `--disable-partial-raster` into
`LayerTreeSettings.use_partial_raster`:
https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc#L297
The bounded test used this single flag identically for the original dbad720
source and candidate. Both actual protected PNGs became byte-identical. Four
real CSS negative controls each altered exactly pixel (159,225); exact hashes
rejected all four. An independent review permitted this environment repair only
in the secondary visual configuration, with proxy/isolation and every original
navigation, first screenshot, baseline source and assertion retained.

This changes the rendering environment, not the baseline source: Schedule's old
baseline PNG differs by seven pixels from the new-environment baseline, and its
candidate differs by eight. Native paint commands remain unchanged. We do not
claim old PNG bytes were preserved or that a high-contrast one-pixel mutation
proves coverage of every default-partial-raster-specific bug. Production and
performance browsers retain their original configuration. The original complete
visual gate, including Library and 320/200%, must still pass independently; no
AA ignore, mask, crop-edge removal, tolerance or production repaint is permitted.
The one-pixel sensitivity check is also retained on a separate page in that gate.

## Measured timing-ownership indexing repair

The single native compact profile did not reproduce the historical 51ms task;
its exact cause remains unknown. It did show a real 19.095ms renderer task with
about 11.884ms inclusive / 8.255ms self time in `actionNodesById`. That function
rescanned and sorted all latest nodes for every action, plus repeated linear
opportunity/event searches. The repair indexes these relationships once while
retaining first live-event/opportunity matches, latest-occurrence insertion
order, stable version ties, terminal/live ownership, conflicts and corrections.
Only local derived lookup arrays/maps are mutated, never snapshot objects.

A frozen pre-repair scan-based oracle, 200 seeded mixed histories, explicit
missing/null/duplicate cases and a 1000-action/1000-node linear-access test guard
semantics and scale. Local full unit acceptance is 331 files / 3623 tests, with
typecheck and production build passing. These results do not replace native
browser profiling or the original unprofiled 50ms gate. No historical performance
failure is waived and no performance threshold changed.

The first complete repaired visual run (39066618891, artifact 12113324045)
passed all Today/Schedule exact comparisons and the added one-pixel controls.
Baseline passed 19/19; candidate passed 16/19. The three remaining failures were
unchanged Library rows1440 (8 pixels), rows390 (394), and search320/200 (11).
For rows390, 362 differences are the entire final raster row: its 358.953125px
panel starts at viewport y486 after the locator scroll, crossing the 844px
viewport. Playwright 1.63 decides `fitsViewport` from width/height alone and
passes `captureBeyondViewport: false`, incorrectly clipping that edge:
- https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/screenshotter.ts#L223
- https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/crPage.ts#L273

The region capture now uses native full-page document-coordinate clips with the
same complete enclosing integer rectangle (Playwright's own rounding). All
region pixels, dimensions and exact hash assertions remain; no edge is removed
or pixel rewritten. A separate synthetic below-viewport fractional-edge case
must detect a genuine one-pixel change on that final row. Remaining rounded-edge
differences are not waived by this capture repair and require actual evidence.

The isolated clip run39067631508 / artifact12114067028 confirmed that the
complete 362x359 rows390 image now differs by 32 rounded-edge pixels, with zero
last-row differences (formerly 394 including 362 clipped pixels). Both 20x21
synthetic negative images alter exactly output pixel (0,20) on the final row and
are rejected. Rows1440 still differs by eight pixels, search320 by eleven; all
three original exact assertions remain failed, not exempted.

Unprofiled repair-head run39066618889 / artifact12113369029 passed recovery38
and isolation5 but failed the original history3940 long-task gate at 55ms.
Compact confirmation and domain budgets passed that run; they do not waive this
failure or the older compact51ms. Native clock evidence places the 55ms task at
3109.5–3164.5 before the first pointerdown3233.4 and first capacity window3264.5,
inside Playwright's first locator wait but without a CPU stack to identify its
cause. It is not the separate 62ms second capacity elapsed sample. The next
single native profile retained the observer boundary and did reproduce a 53ms
failure (run39067631508 / artifact12113987345), with timeline/CPU/GC evidence
preserved for attribution. No observation-window filtering or added settling
wait is used to exclude either failure.

The native 53ms failure is now attributed to application work. Its renderer
RunTask spans 2944.130–2997.219ms (53.089ms), with 52.931ms in RunMicrotasks.
CPU samples resolve to `readLocalSnapshot -> createSnapshot`, followed by
`assertLocalSnapshotCurrent -> canonicalWorkspaceJson` for both values.
`createSnapshot` occupies approximately 28.82ms (sampling estimate), including
5.707ms of measured MinorGC; its redundant structured-clone phase has roughly
11.5ms of self samples. The two canonical computations take approximately
11.42ms and 10.94ms, followed by about 1.29ms comparing their large strings.
The neighboring async work is consistent with the post-fetch currentness check
in `runCloudSync`. This is not Playwright selector injection, and the original
observer correctly reports failure even though input arrives later.

The narrow repair consumes the fresh, exclusively owned IndexedDB get/getAll
results only inside that currentness check, avoiding a second full-history clone.
A shared normalization/validation implementation is used by both entry points;
the public `createSnapshot` still defensively clones its caller's data first.
The all-store readwrite transaction, every lease check, complete validation,
abort handling and exact two-sided canonical comparison are unchanged. Other
snapshot read paths continue to copy. Tests cover dense-history output parity,
legacy normalization, public-copy isolation, invalid audit facts, all-store
locking, late local changes, externally mutated expected data, discarded-read
aliasing, and lease changes during reads. No timer or observer change is used.

A neighboring 48.941ms task in `isRecordedAccountProjection` also performs a
large recorded-proof comparison. It did not exceed the original threshold in
this trace, but remains a performance risk; this narrow change does not alter
its proof or canonical semantics. Neither the original 55ms failure nor the
older unknown-cause 51ms task is retroactively dismissed. Browser acceptance
must rerun the unchanged unprofiled performance gate on the final product head.

Narrow-repair local validation: 333 files / 3637 tests passed with two local
workers, typecheck and sequential production build passed. The earlier concurrent
full-unit/build attempt ended with two SIGKILL workers and build exit137; its
331 passing files are not counted as a full pass. No CI worker setting or budget
was changed. Independent read-only review passed 22 focused tests and 28 old-
implementation parity cases (eight accepted, twenty identically rejected),
including frozen inputs, nested alias mutations and receipt-order normalization.
This establishes limited correctness only, not native performance acceptance.

## Complete-region tile-raster determinism

The bounded visual-only experiment on unchanged product2c1bb8 is retained at
https://github.com/haohongfei2001-png/pjsdas/actions/runs/39068515885/artifacts/12114098368
Both the original dbad720 source and candidate used the official
`--default-tile-height=4096` together with the previously reviewed
`--disable-partial-raster`. Chromium153.0.8010.12 reads the height setting here:
https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc#L257
Native `cc::Tile` content rectangles all had vertical origin0, with actual
layer-bounded heights such as896,960,1024 and1792. The flag is not expected to
make every small layer4096px tall. No production DOM or CSS changed.

Both four-test phases passed: all24 protected first PNG pairs and their repeats
were byte-identical. The prior rows1440/rows390/search320 differences8/32/11
were zero. In each phase the separate20x21 edge negative changed exactly
(x0,y20) from(30,60,90) to(244,0,244), rejected by the original exact hash gate.
Independent review confirmed unchanged old/new Library geometry contracts and
all24 captured Library DOM element/root/state contracts. The old→new environment
still changes pixels: baseline/candidate19/11 for rows1440,6/38 for rows390,
and7/14 for search320. Old images and failures are preserved; this does not
claim the original PNGs are unchanged or replace the fixed baseline source.

The diagnostic also added read-only native tracing, which can affect timing.
Therefore it is a limited clean result, not proof that a single causal variable
has been completely isolated. The official secondary configuration adds only
the tile-height argument; its original complete20-test gate has no new CDP hooks
and must independently pass both source builds. Every original exact region,
whole-page assertion, first-capture rule, geometry/filter contract, threshold
and one-pixel negative remains. Default-tile-specific browser artifacts are not
claimed covered by this deterministic environment. Production and performance
browser configurations are unchanged.

An earlier metadata-only attempt failed before any journey because this harness
intentionally excludes `--enable-automation`; its optional command-line query
was removed without adding that flag. Failure evidence remains:
https://github.com/haohongfei2001-png/pjsdas/actions/runs/39068275328/artifacts/12114461013
The history profile job was not repeated in either visual experiment.
