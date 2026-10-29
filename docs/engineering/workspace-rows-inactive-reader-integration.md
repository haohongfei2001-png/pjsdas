# Inactive reader bridge: source integration boundary

Local source candidate only. The required additive database bridge must exist
**before either A′ or B′ is released**; there is no flag or raw-snapshot fallback.

`transactionalWorkspaceStore.ts` changes only three inactive read projections to
`GET /rest/v1/rpc/pjsdas_read_legacy_workspace_v1` with `target_user_id`, original
`select`, and `limit=1`. `readForUser`, `readIdentityForUser`, and
`readDiscoveryProfileForUser` keep the server-verified owner and service-role
transport. The source's existing caller signal/deadline and pre/post layout
fences remain. Active-owner row routes are unchanged. The complete pending-305
logical overlay and ledger path are unchanged. Invalid multirow/nonarray replies
are refused rather than silently accepted.

The raw **metadata-only** layout probe remains
`pjsdas_workspaces?select=id,user_id,row_candidate_epoch`; it does not request
`snapshot`. RPC missing/forbidden/active-conflict/timeout/unavailable responses
never retry via the old blob path. A missing inactive row is still an empty SETOF
result, whereas an active owner must raise PT409 rather than masquerade as absent.

## Compatibility pair

The original A (`0d056961…`) and frozen staged checkpoint (`d036b343…`) contain
the exact same `transactionalWorkspaceStore.ts` source before this patch. Thus
the minimal reader patch applies to both without changing the row contract.
The independent A′ reader-only branch now passes TypeScript, its 21 focused
reader tests and a SHA-bound build. Its actual API entry is native-tested under
the narrowed ACL: inactive full-v4 save, reading B′ staged state and original V5
replay pass. It does not include the new staged writer. Neither this result nor
the original static equality is a hosted staged-compatible rollback pair. Both
builds must include this unconditional RPC read route; turning row feature flags off must
not revive the old blob read. Keep additive bridge capability through rollback.

Lightweight tests exercise the connected handler with verified synthetic identity
and reject request-body owner spoofing. The new native harness additionally
invokes the actual `api/workspace.ts` factory with public-only PostgREST, the
restricted-role reader and exact nine legacy function substitutions: inactive
full-v4 commits still work, raw snapshot SELECT is denied, and active legacy reads
return PT409. Historical full-matrix tests install only the additive bridge to
retain their original ACL assertions; those tests are not reader-retirement proof.
A real hosted A′/B′ pair remains a separate gate.

## Restricted-role migration constraints

The independently verified restricted-role design supersedes the earlier
zero-membership/auth-grants assumption. Its migration must preserve all these
constraints, not merely paste the earlier privileged-role script:

- Reader role is NOLOGIN, NOINHERIT, NOBYPASSRLS and not granted to application
  roles. A non-superuser creator can retain a platform-created ADMIN-only
  membership (SET=false, INHERIT=false); removing that bootstrap grant is a
  separate higher-privilege action, not something the creator can promise.
- Narrow EXECUTE while the creator still owns functions, **before** ALTER OWNER.
  Temporary creator SET and private-schema CREATE are removed afterward. A
  warning-only unsuccessful REVOKE/GRANT is not evidence of the desired ACL.
- No new auth.USAGE/auth.uid grant is assumed. The private reader checks actual
  `current_setting('role', true) = 'service_role'` and mirrors official UID
  extraction semantics. A nonnull UID must match owner; invalid claims fail
  closed. A no-sub service request still relies on the original verified-server
  owner trust chain, not a browser-supplied target.
- Object ownership/schema CREATE rights needed for RLS/ownership work must be
  verified separately from table SELECT/UPDATE grant options. Keep the public
  wrapper SECURITY INVOKER and service-only; retain the original business
  functions as INVOKER with exact approved body substitutions only.

Object ownership and database/public-schema creation/grant capabilities must be
verified against approved exact preimages before any execution. This source
contract makes no claim about any production catalog. New reader ownership transfer,
atomic platform DDL transport, event-trigger/ACL approval and acceptance or
separate cleanup of ADMIN-only membership remain open. The SQL files are local
fixture candidates, not production migrations. No production DDL, role membership,
credential or exposed schema is changed or authorized by this source work.
