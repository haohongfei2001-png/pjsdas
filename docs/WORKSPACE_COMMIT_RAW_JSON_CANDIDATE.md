# Raw-body commit candidate: not production-approved

The metadata-only v3 removes returned-snapshot materialization, but real PostgREST
named arguments still pass through `json_to_record`. The direct SQL benchmark did
not cover that layer. PR #295's native PostgreSQL 17 test demonstrates both layers:
25 MB synthetic input, work_mem 2184kB, first-commit temporary read/write blocks each
6592 for v2 and 3296 for v3 through the PostgREST-shaped SQL. This does not attribute
all production IO or establish the cause of any canceled request.

## Candidate security and compatibility delta

Add only `public.pjsdas_commit_workspace_v4(jsonb)`, with one **unnamed** input so
PostgREST passes the raw JSON body directly. It is SECURITY INVOKER, with explicit
search_path and a schema-qualified call to existing v3. Execution is revoked from
PUBLIC/anon/authenticated and granted only to the existing service_role. There are
no new table/role/RLS privileges, no new credentials and no existing-function edits.
The raw boundary requires exactly the same 13 named fields. Scalar extraction
avoids a record-valued expansion; JSON null becomes SQL NULL as before. CAS, locks,
ledger, receipt and hash checks remain in unchanged v3. Only four metadata columns
are returned. Large receipts themselves remain a separate potential cost.

The gateway uses v4 only for ordinary commits when **both** existing
`PJSDAS_WORKSPACE_COMMIT_METADATA_ONLY=1` and new
`PJSDAS_WORKSPACE_COMMIT_RAW_JSON=1` are set. The new gate defaults OFF. Discovery,
AI capture and consent-guarded management routes stay unchanged. There is no error
fallback to another writer, including a missing-v4 404 or uncertain HTTP 500.

## Verification

Serial PGlite checks strict inputs/nulls, invoker/ACL, installation rollback,
unchanged v2/v3 definitions/ACL, receipt replay, CAS and hash rejection. Client tests
cover all v2/v3/v4 route combinations, no fallback and guarded route preservation.
The existing hosted SQL job runs pinned PostgREST v14.5 on loopback against its
existing isolated PostgreSQL 17 service, using synthetic JWTs and a temporary DB.
It covers actual HTTP, anonymous/authenticated denial, one concurrent CAS winner,
receipt recovery after discarding a response, 25 MB request and small response.
PostgREST plan mode measures the full generated statement with ANALYZE/BUFFERS;
transaction rollback acknowledgement and unchanged revision/ledger are required.
This facility is enabled only inside that temporary fixture, never production.
Exact-head hosted results are required before claiming this candidate works.

## Production gate and recovery

This PR does not itself authorize installation or enabling the new persistent RPC.
Before any later authorized migration: verify v4 absent, privately capture v2/v3
catalog/ACL preimages, install DDL+ACL atomically with bounded timeouts, and compare
originals plus new invoker/ACL signature. This is change-level recovery, not full
disaster recovery. Then enable only the approved Production flag on an existing
deployment and verify the exact version. Passive real-traffic evidence may validate
routing; synthetic zero temp IO is not a production guarantee.

Operational rollback: set only `PJSDAS_WORKSPACE_COMMIT_RAW_JSON=0` and redeploy,
returning to v3 while preserving v4 and all data. Turning off the older metadata-only
flag returns to v2. Never restore an old business snapshot or delete the new function
as a routine rollback. No paid upgrade, global memory change or service pause.

Official transport contract: [PostgREST single unnamed JSON parameter](https://docs.postgrest.org/en/v14/references/api/functions.html#functions-with-a-single-unnamed-json-parameter).
