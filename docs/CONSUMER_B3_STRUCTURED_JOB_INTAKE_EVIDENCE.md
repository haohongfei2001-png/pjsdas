# B3 explicit structured quoted job intake candidate

This next A19 slice follows merged PR273 and remains a separate change.
It is a bounded implementation candidate, not a complete A19 or production
certificate. Its original contract was built on `6990166`; it is now locally
integrated on PR273's compatibility-corrected tree
`41b9614af58a9513caf2a8b2a7c7e03ad6780e3e` (remote commit
`2a57f0c6bcfb739081824e6d3711096f1176112d`, local equivalent `31580482`).
The successor base is merged main `63a251037b4ba1af30d287b4d9e9bdebeb8c63ba`,
whose tree exactly matches that already tested local base. Reapplying the five
slice files onto this parent changes no product/test bytes; only this evidence
document records the final base.

## Supported meaning

An anchored first-party Chinese `请导入/保存/记录以下/下面岗位说明` request
selects an already supplied, single `>`-quoted block as data. The finite field
labels are 公司, 岗位, 地点, 招聘链接 and 申请截止. Company and role are required;
optional fields must have nonempty values when present. Unknown/repeated fields,
nested quotation, unquoted tails and unsupported dates remain unresolved as a
whole. Input is bounded to 4096 characters and twelve body lines.

Values pass through existing `normalizedUserJobFacts` validation, then the
existing `user_opportunity` Semantic Intake candidate and domain creation path.
The result is a saved, not-applied Opportunity with user-asserted fact provenance.
It grants no actor identity or permission and creates no Action, Process,
ProcessEvent or ScheduleNode. Instruction-like words inside a recognized scalar
field remain literal field data; they are never interpreted as operations.
Standalone source instructions or extra fields fail closed. Existing source
authorization, duplicate identity handling, receipts and time precision remain
in the domain path. URLs are references only: no network fetch, attachment
extraction, general natural-language JD parsing or automatic application occurs.

## Evidence so far

- The initial real-domain contract on `6990166` produced 8 expected failures and
  30 passing rejection controls. No previous full run certifies the new bytes.
- The first minimal adapter made all 38 cases pass. Independent review then
  reproduced two whitespace-only optional fields being silently dropped.
  Trim/nonempty validation now rejects them, with six space/tab/NBSP regressions.
  The original review failure is retained separately.
- The corrected contract passes 44/44. Independent review reran the contract,
  original blank-field counterexamples and adversarial wrapper/body/authority
  probes, and reports CLEAN for the bounded slice.
- Existing notice/timezone/B1 plus new job controls pass 291 tests in six files;
  the existing completion suite separately passes 13 tests. TypeScript build-mode
  checking and whitespace checks passed at that initial stage; no full-suite
  evidence from an earlier candidate was substituted for this slice.
- One combined browser journey reuses the unchanged existing synthetic transport
  fixture and actual gateway DTO/domain. It checks the add-job preview, saved
  Opportunity, no personal operations, local projection, repeat after reload,
  and an unquoted withdrawal. Static review is clean and test discovery sees
  seven cases (six unchanged notice cases plus this case). Browser runtime is
  pending; local execution was not attempted because the environment's browser
  restriction remains in force.
- Integration onto the corrected Web planning/completion adapters changed only
  adjacent imports; both helpers are retained. The combined JD, untimed capture
  compatibility and finite planning-time contracts pass 111/111 on this
  integrated tree. The preceding PR's 3930-test full run does not cover the
  additional JD bytes. A separate final integration review of fixed runtime/test
  revision `0955fdad` reports CLEAN: the 44 contract cases and twelve independent
  integration/domain probes pass, including literal instruction-like scalar
  fields, withdrawal, duplicate/unsupported fields, cross-wrapper dedup and
  source/authorization rejection. No product or test bytes changed during review.

On frozen local revision `26c13e579cf6351335165e82e2bef5dbdbe21cfb`
(tree `6b70fd960ab74b385cb7bc54de8efb0c053f24a9`), one full UTC unit run passed
341 files / 3974 tests on its first attempt (23.26s), followed by one successful
production build. The existing >500KB chunk warning was retained. Only the
build-generated release identity was restored to its committed unbound fallback;
product and test bytes did not change. This evidence update is documentation only.
Official changed-head CI and the new browser journey remain pending.

Full acceptance is batched for the frozen candidate rather than repeated after
each small correction. This next slice is not yet
published or certified.
