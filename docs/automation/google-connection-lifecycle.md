# Google connection recovery

## Guarantees and limits

Google may revoke or expire refresh authorization. This patch cannot guarantee permanent consent, determine the project's publishing mode, or restore a revoked grant without the owner's reconnect flow. TodayAction's stored Google binding is independent of any assistant Gmail connector.

The refresh helper makes at most two attempts for transport failures, malformed responses and temporary provider errors, with an eight-second per-attempt timeout inside the existing execution budget. Only an explicit OAuth `invalid_grant` on a 400/401 response marks reconnect required. Client configuration errors and a resource API's access-token rejection are separate failures. Responses and plaintext credentials are never included in errors.

Rotated refresh credentials are encrypted and compare-and-set against the exact stored generation before use. Controlled Gmail rotation retains only the caller's proven live lease with its original expiry; other in-flight executions remain fenced. Non-controlled Gmail, discovery and watch state updates are generation-fenced, including success/error updates. A persisted invalid-grant marker prevents repeated doomed refresh and cannot be cleared by a late same-generation success.

Same-subject reconnect/rotation retains durable history, pending pages/message IDs and reconciliation continuation. Scope order does not change scope meaning. Different-subject replacement resets mailbox checkpoints atomically and disables Gmail until explicit consent. Explicit disable, scope loss, account revocation and consent removal retain the existing fail-closed expanded-consent cleanup. Reconnect is not equivalent to toggling a setting.

Settings show reconnect-required, configuration failure, retry pending, missing completion and stale completion distinctly. Attempt time is separate from the last complete sync. Freshness uses the existing Gmail source-registry SLA. Discovery still requires a configured profile and its independently authorized budget; an enabled switch/check does not establish a search or durable discovery.

## Deployment order

1. Review `20261005211006_google_refresh_lifecycle.sql` and run the full unit/type/build and Consumer Management SQL gates against the exact proposed commit. The SQL test applies the actual ordered binding-domain migrations, including consent and lease triggers and scheduler ACL changes. It excludes only extension installation and scheduler operations from its in-memory fixture.
2. Apply the reviewed migration through the existing bounded migration deployment procedure. It adds two worker-authenticated, generation-fenced RPCs and updates existing functions/triggers. It creates no table, schedule, credential, opt-in, paid service or OAuth configuration; no existing user binding is rewritten by deployment.
3. Deploy the matching backend and frontend to existing resources, then verify exact release identities and read-only operational status. Do not enable the dormant fragment-reprocessing job, change discovery preferences/budget, or manually refresh provider credentials as a deployment check.
4. Only then ask the owner to complete the existing Google reconnect flow if reconnect is required. Let the already-authorized scheduler perform normal catch-up. Check that attempts resume, the durable success time advances only after complete ingestion, and existing idempotency/receipt tests remain passing.

The new gateway requires the new RPCs for state finalization; deploy the migration first. Avoid a prolonged mixed backend deployment. Legacy direct worker RPCs remain for compatibility and must not be used by new code.

## Verification and rollback

- Synthetic OAuth tests cover transient retry, abort, malformed payload, invalid-grant/configuration distinction, encrypted rotation, storage failure and generation conflicts.
- Synthetic SQL tests cover worker scope/ACL, same-subject recovery, explicit disable/revoke/scope removal, all stored error formats, stale rotation/revocation/finalization, sticky revocation, equivalent reordered scopes, and owned-lease rotation through finalization without extension. The optional `--postgres` mode uses only the existing CI loopback fixture and exercises real multi-session row-lock races; it never accepts a production URL.
- Settings tests cover stale read/write conflicts and push enable after its own rotation. UI rendering tests cover Chinese/English reconnect and transient/configuration states.
- No live provider request, credential read/refresh, recruiting-record mutation, schedule change or production migration is part of these local tests.

If deployment verification fails, stop owner reconnect instructions and roll back the backend/frontend release using the existing release mechanism. Do not reverse encrypted credential rotation, reset checkpoints, clear the reconnect marker or restore old credential material. The additive SQL is compatible with the prior gateway but that gateway lacks the new lifecycle protections; keep rollback brief and do not claim the issue fixed until the matching release is restored. Any SQL rollback needs separate review against current state and must preserve checkpoints and access restrictions.
