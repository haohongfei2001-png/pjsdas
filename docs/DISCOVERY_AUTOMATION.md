# PJSDAS Server-Owned Job Discovery

Status: v1 implementation contract.

## Product contract

PJSDAS can run recurring public-web job discovery without requiring ChatGPT Tasks or a per-user search/model API key.

Background discovery is **explicit opt-in**. Connecting Google, opening PJSDAS, or configuring a Discovery Profile does not by itself authorize server-owned public-web/model processing. The user enables **Background job discovery** once in Settings and may turn it off at any time. Only connections with `discovery_automation_enabled = true` are claimable by the worker.

The durable Discovery Profile and Decision Rules remain user-controlled. Background discovery never edits those preferences, never decides that the user has rejected an Opportunity, never deletes objects, and never changes a recruiting Process merely because a public posting opens or closes.

The Source Registry remains the cadence authority. The four bootstrap monitor identities are:

- `monitor:urgent-campus`
- `monitor:state-foreign-2027`
- `monitor:middle-layer`
- `monitor:key-changes`

Each currently has a 24-hour cadence and 36-hour freshness SLA. The scheduler may wake more frequently than that; the worker itself only executes a source when the Source Registry says it is due. Zero-result completed searches are still ingested so Coverage reflects actual execution rather than silence.

## Runtime architecture

```text
User enables Background job discovery once
  -> discovery_automation_enabled = true
  -> Supabase pg_cron
  -> Vault-generated discovery worker token
  -> POST /api/automation-discovery
  -> claim only opted-in Google/Drive bindings
  -> decrypt stored Google refresh token on the server
  -> read the canonical PJSDAS Drive workspace
  -> build the deterministic discovery automation plan
  -> Vercel AI SDK -> AI Gateway live-web search
  -> strict bounded observation schema
  -> existing hardened monitor-ingestion core
  -> optimistic Drive write
  -> ingestion ledger / Coverage / Source Health
```

The database scheduler is enabled only after the exact merged backend commit has passed the normal Vercel -> Pages -> Production Self-Test chain and the AI Gateway probe succeeds.

## Search/model provider

The worker uses the Vercel AI SDK with a plain provider/model string. On Vercel this routes through AI Gateway and lets the platform SDK own project OIDC authentication. PJSDAS does **not** obtain a project OIDC token and replay it as a raw REST API key. The Gateway's `AI_GATEWAY_API_KEY` environment variable remains an operator-level fallback for environments where an explicit key is intentionally configured; end users never supply a model/search key.

The default model is `perplexity/sonar`, selected because the model performs current public-web search. `PJSDAS_DISCOVERY_MODEL` may replace the deployment-wide model without changing user workspaces or the ingestion contract.

The worker does not trust inbound HTTP headers as model identity. AI SDK/Gateway authentication failure remains fail-closed: PJSDAS must not synthesize a run or pretend Coverage is fresh.

## Bounded data sent to the search model

A source run receives only the minimum context required to interpret current public postings:

- the explicit Discovery Profile;
- active decision weights relevant to discovery;
- up to 100 existing Opportunity identities needed for duplicate/identity awareness;
- up to 40 recent rejected-discovery summaries needed to avoid immediately resurfacing the same rejected candidate;
- the exact source-run objective, query hints, incremental lower bound, refresh targets, max-observation bound, and execution rules.

The worker does **not** send the full Drive workspace, raw Gmail contents, arbitrary Timeline history, resume files, attachments, or unrelated personal data to the search model.

## Persisted output

Model output is accepted only after strict schema validation. Each observation must contain a stable source identity plus a public source URL. Unknown facts stay unknown rather than being inferred.

PJSDAS persists the same bounded data already defined by trusted monitor ingestion:

- stable sourceRecordId;
- company and role;
- public source URL/title;
- directly supported location/deadline/compensation/posting status when known;
- bounded discovery rationale and confidence/score interpretation;
- ledger outcome and run accounting.

Raw fetched page bodies, search-result dumps, model prompts, and raw model responses are not persisted in the PJSDAS workspace or the automation-state table.

## Posting lifecycle vs recruiting lifecycle

A public posting becoming `closed` or expiring is a posting-evidence fact. For an already known logical Opportunity, the hardened ingestion layer must still merge that changed source fact even if the current Discovery Profile would reject it as a new candidate.

This does **not** close the user's recruiting Process, mark the user rejected, or complete/skip any Process Action. Recruiting state changes require recruiting-process evidence such as Gmail or an explicit user action.

A stable sourceRecordId identifies the posting across runs. The same sourceRecordId with the same fingerprint is a duplicate. The same sourceRecordId with a changed fingerprint is re-evaluated and may update existing posting evidence; it is not permanently suppressed merely because it appeared in an older run.

## Failure semantics

- discovery opt-in disabled -> binding is not exposed to the worker at all.
- AI Gateway auth unavailable -> fail closed; no fake run.
- model/search unavailable -> fail closed; retry on the next scheduler wake.
- malformed model output -> fail closed; no partial write.
- ambiguous logical-job identity -> ledger `unresolved`; do not guess.
- Drive workspace conflict -> re-read canonical state and retry once.
- source disabled or not due -> skip without manufacturing freshness.
- completed source with no qualifying observations -> ingest an explicit zero-result run.

Every submitted observation is accounted as created, merged, updated, duplicate, filtered, ignored, or unresolved by the existing ingestion contract.

## Database security boundary

The original `pjsdas_claim_discovery_automation_bindings` SECURITY DEFINER function owns the independent Vault-token validation and is now an internal implementation detail: direct `anon` and `authenticated` EXECUTE permissions are revoked.

The scheduler-facing `pjsdas_claim_enabled_discovery_automation_bindings` wrapper calls that token-validating internal function and then returns only rows whose `discovery_automation_enabled` flag is true. The normal signed-in `authenticated` role cannot execute the wrapper. The anonymous PostgREST role may reach the wrapper only because the Vercel worker has no end-user browser session; the independent Vault worker token must still pass the inner validation before any privileged row can be returned.

`pjsdas_update_discovery_automation_state` likewise validates the independent worker token before updating bounded check/success/error telemetry. It does not change user opt-in.

## Deployment checklist

1. Apply the additive discovery-worker and explicit-opt-in migrations. Do not schedule the cron yet.
2. Confirm the intended user explicitly enabled Background job discovery; do not infer consent from Google connection or Discovery Profile state.
3. Merge only a CI + Chromium green candidate.
4. Verify the exact merge SHA is running on Vercel.
5. Let the backend-first Pages gate and Production Self-Test pass for the same SHA.
6. Run an authenticated scheduler-token AI Gateway probe; require HTTP 200 and the strict zero-observation JSON contract.
7. Run one bounded real server-owned discovery execution and verify balanced ingestion / optimistic Drive write.
8. Schedule the production cron. A 6-hour wake interval is sufficient while Source Registry cadence remains 24 hours.
9. Disable legacy ChatGPT monitor tasks only after the server-owned path has succeeded end to end.
