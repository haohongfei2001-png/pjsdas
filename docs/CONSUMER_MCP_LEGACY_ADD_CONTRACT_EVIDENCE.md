# Explicit job-add client contract compatibility

Date: 2026-10-18. Baseline: main `112e3617fde42ad99f45059ca2770128ae744475`, tree `29cbcdbee97852e5e5c3a02deac0d02f0c3ffa8f`.

## Observed failure and scope

The installed TodayAction `add_opportunities` catalog still requires company,
role, sourceTitle, sourceUrl, and retired roleType. The live source contract
requires only company/role and permits optional source facts. Its strict parser
rejects roleType before workspace access. Optional installed scoring fields,
rationale, discoveredAt and postingStatus are not required to make a valid
legacy call. No other required retired field was found.

OpenAI documents that approved MCP tool definitions are frozen and a server
schema change does not automatically refresh the client:
[Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-apps-in-chatgpt-beta).
The existing private plugin identity was verified read-only. A cloud-browser
settings check reached an unauthenticated page, so no supported Refresh action
was available. No plugin permissions, credentials, connection, or publication
settings were changed. Editing a plugin skill is not a tool-catalog refresh.

This repair is the bounded compatibility adapter allowed by the current
convergence plan section 6.5. It does not restore job classification or scoring.

## Change

`gateway/addOpportunitiesMcpSchema.ts` uses the SDK's documented Standard Schema
interface. Its runtime validator accepts only the five former roleType enum
values as an optional field and discards that field before revalidating the
strict canonical request. Its JSON converters are the unchanged canonical
facts-only converters. `serverFactory.ts` uses it only for `add_opportunities`.

The domain parser, hashes, deduplication, authority, CAS, durable receipts,
readback and compensation code are unchanged. New jobs have no roleType. No
default classification is inserted. Scores and every other unknown input still
fail. Direct domain invocation still rejects roleType. Explicit add requires no
Discovery Profile and creates no application Action or calendar event.

## Evidence

- Deterministic RED: an HTTP MCP tools/call with the installed client's exact
  required shape returned isError before the patch. All fixture jobs and URLs
  were synthetic. No live workspace mutation was performed.
- GREEN: modern tools/list is deeply equal to the canonical strict schema;
  company/role are the only required job facts and retired properties are absent.
- All five legacy enum values are removed before identity calculation and writes.
  Modern, repeated and changed-enum calls retain the same canonical identity.
- Invalid enum values, scores (including zero), optional retired fields, unknown
  root/candidate keys, invalid facts, empty/oversized batches and mixed invalid
  batches fail before any workspace read/write.
- Transactional HTTP tests cover normal and lost-ack commits: canonical payload
  hash, same original durable receipt/time, one write across legacy/modern
  replays, and COMMAND_ID_REUSED for actual changed facts. Recorded command and
  semantic receipt payloads contain no roleType.
- Existing strict direct-invocation rejection and source-free/no-profile tests
  remain unchanged. Independent code and transactional-path review: CLEAN.
- Targeted contract suite: 63 passed; final transactional delta: 13 passed.
- One fixed-candidate UTC full unit run: 350 files / 4281 tests passed.
- Production build passed on the same fixed source candidate. Official
  exact-head CI and deployment remain pending and are tracked in the PR before
  this is reported as available in production.

## Remaining limits and rollback

This adapter cannot remove sourceTitle/sourceUrl requirements from an already
frozen client catalog. Source-free jobs require a refreshed client; server-side
modern source-free support remains intact. Optional retired fields must still be
omitted. The seven reported real jobs were not added or counted as saved during
engineering verification; their real facts and duplicate identities require a
separate authorized readback/add workflow.

Rollback may revert only this adapter registration/module to the strict baseline
behavior, which would again reject stale-client roleType. No data migration or
production record rewrite is needed. Preserve all pre-existing timezone,
provenance, authority, scheduling and receipt guards in main112e.
