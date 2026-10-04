# Approved production migration result — 2026-10-04

The eight approved migrations are installed in the original Supabase project `yyrzwpoxlxpafdlbkdtg`. Consumer admission and feature flags remain unchanged/off. This is a database maintenance receipt, not completed plugin installation or consumer acceptance.

## Scope and recovery evidence

The user explicitly approved temporary maintenance access for this project only, for at most 24 hours, restricted to private backup, actual recovery verification and the original eight migrations from `9055fa21b1bffeed06bf18e69cf5511fa16c6f02`. Original SQL and `pending-migration-checksums.json` are unchanged. The manifest's historical source/status fields describe its creation; this dated result records execution.

The actual production snapshot was captured at 2026-10-03 21:14:34 UTC and restored offline before migration. Its archive SHA-256 is `da110e1a0a3ca26445b05d4ccfaae98227008843ce7fbb433e8e787e4965cb77`; encrypted archive SHA-256 is `399cf82d7f4916a1a831153a1bccf22687c78d1dc03638c17e779745993b907b`. The private encrypted archive and separate private recovery key are retained outside Git and deliverable attachments. No source credentials or user rows appear here.

All 39 captured tables and 2485 rows, schema definitions, owners, ACLs, RLS, role flags/membership and migration history matched the restored copy. Source PostgreSQL 17.6 was restored with native PostgreSQL 17.11; no platform upgrade occurred. Restore servers listened only on a private Unix socket and are stopped. SQL comparison normalized only server-version headers, pg_dump restrict nonce, privilege-array ordering after exact tuple comparison, and order within consecutive additive default-privilege GRANT blocks. No REVOKE, privilege or row was dropped from verification.

This logical recovery point covers public, auth and supabase_migrations dependencies for these changes. It is not full-project PITR and excludes Storage object bytes, platform configuration and original role passwords. Recovery authority was verified for existing/new public objects and migration history affected by the approved files; it does not claim authority to rebuild platform-owned Auth infrastructure. A future production recovery must preserve subsequent legitimate writes and restore only affected objects, never overwrite the live database with this old snapshot or automatically delete data.

## Execution and independent readback

The final maintenance session ran from 2026-10-04 08:47:38 UTC through native-role cleanup at 08:49:04 UTC. Before SQL, the native TLS connection verified the pinned CA, hostname and project/session identity, the complete schema/ACL baseline, all permanent role flags and all 24 membership rows including grantors, and exact existing migration history. Incomplete earlier membership evidence was supplemented rather than classified as drift or changed.

Each original complete file ran in its own explicit native transaction with `lock_timeout=2s`, `statement_timeout=15s`, transaction-identity checks and its migration-history INSERT. Each commit was read back before the next file. Existing row fingerprints were identical within the same repeatable-read snapshot before/after each file, and new tables were empty. All eight completed without a SQL retry or timeout extension:

| Order | Exact migration version | Result |
| --- | --- | --- |
| 1 | 20261002175431 | Committed and read back |
| 2 | 20261002195807 | Committed and read back |
| 3 | 20261002211312 | Committed and read back |
| 4 | 20261002220516 | Committed and read back |
| 5 | 20261002234255 | Committed and read back |
| 6 | 20261003083410 | Committed and read back |
| 7 | 20261003091106 | Committed and read back |
| 8 | 20261003104723 | Committed and read back |

A separate existing management connection confirmed all eight original statement hashes and the final expected catalog: 40 table objects, 135 indexes, 3 schemas, 9 default ACL entries, 8 policies and 38 functions. All permanent role flags and membership/grantor rows were unchanged. This includes expected new scoped-consent objects, not a blanket claim that migration DDL changed no schema.

Existing v2 write, same-command idempotent replay and undo passed on the actual restored production copy after the full eight-file chain; original raw snapshots were preserved and regression writes rolled back. Production validation was read-only apart from the approved migration files/history: no existing user's workspace was used for a live write experiment. Synthetic v7 A/B/C tests remain separate from real-host acceptance.

## Revocation and preserved failures

Official temporary CLI logins were deleted after sessions closed, and old database credentials rejected with SQLSTATE 28P01. Scoped management tokens were deleted in the original account dashboard; final old-token probes returned 401. Readback found zero temporary roles, zero temporary sessions and zero maintenance sessions. Private access-credential files were deleted; only the encrypted recovery material remains. No password reset, new service charge, additional project, user grant, OAuth change, public policy or plugin publication occurred.

Earlier local restoration attempts encountered a schema-only decode pipe EPIPE, ACL item/default-GRANT ordering and one wrong local restart port. These were diagnosed and corrected without dropping comparisons; prior failure evidence remains. A production attempt stopped locally at 0/8 because the short native password expired before connection; that authorization was cleaned before proceeding. The successful attempt issued the short login and immediately ran the prepared executor, then removed the role in a finally block. It did not replay previously submitted migration SQL.

The final management-token probe immediately after deletion returned 201; after confirming the token was absent in the original dashboard, the subsequent probe returned 401. Cleanup is confirmed by that later rejection, not claimed as a first-attempt pass.

## Remaining consumer gate

The original plugin's backend edit identity and installed OAuth/tool catalog must still be verified through its owning account. Exactly two dedicated user-controlled identities must explicitly consent to controlled business-v7 admission and then separately authorize the first-party business scope. The local preparation page records this bounded permission only; it does not enable flags, insert grants or register accounts. Other domains and public release remain outside the approved scope.

Product contracts: [first batch](batch-1.md), [business v7](business-v7.md), [planning v4](../management/planning-v4.md), [discovery/profile v5](../management/discovery-profile-v5.md), and [delivery/host acceptance](plugin-delivery.md).
