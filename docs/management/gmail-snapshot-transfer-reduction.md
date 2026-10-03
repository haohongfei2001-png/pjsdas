# Gmail transactional snapshot transfer reduction

The Gmail transactional path reads a workspace, derives a bounded result, then calls `WorkspaceSource.write`. That write previously fetched the whole workspace again to compute receipt object differences before its existing compare-and-swap commit.

An explicit Gmail-only option retains a private cloned preimage from the preceding read. It is consumed at most once by the same source instance, for the same owner and observed revision. The caller cannot mutate this private baseline through the returned snapshot. Before reuse, a metadata-only request verifies the current workspace ID, owner, revision and captured stored schema version. The normalized public schema version remains unchanged, including valid legacy snapshots. Missing, replaced or changed state refuses the write; a change after that check still conflicts at the unchanged atomic RPC. A source without a matching preimage keeps the full-read path. Read-only MCP sources retain the default behavior and incur no extra clone retention.

The optimization does not change polling, authorization, schema, scheduling, snapshot mutation semantics or external delivery. It only changes one eligible read's selected columns. No global cache or cross-request data is introduced.

The standard synthetic dense fixture serializes a workspace response to4,441,119 bytes and the identity response to93 bytes. Thus one eligible write avoids4,441,026 response bytes in that fixture. This is not a measurement of any live workspace, billing period, quota attribution or production saving.

Validation covers private preimage isolation from caller mutation, owner/instance/revision isolation, replaced workspace identity with reused revision, stored-schema mismatch, legacy schema normalization, pre-check and post-check concurrency, and one-shot consumption. Full source tests and gateway types are required, followed by exact-head hosted checks and review before deployment. Billing/egress totals require the provider's actual usage view; missing response-size headers cannot establish them.
