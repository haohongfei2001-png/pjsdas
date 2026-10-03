# Consumer management: first implementation batch

本轮受控范围以 [controlled-v7-review.md](controlled-v7-review.md) 为准：仅精确 A/B beta + 原 client 的业务 v7，其他消费者领域另行同意；全部关闭仍可第一方撤权。源代码能力不代表线上开放。

This is a gated foundation, not the complete consumer plugin rollout.

This is the historical first-batch receipt. Later persistence, consent UI and runtime wiring are described in [business v7](business-v7.md) and the [current delivery entry](plugin-delivery.md); pending items below reflect the original batch, not a fresh inventory. Consumer scopes remain separately gated and do not inherit owner v2 permission.

Implemented:
- Strict read and create/update/archive schemas for independent Prep, independent manual Action, ApplicationGroup. Prep records already referenced by materialized actions/schedules are rejected for generic updates until shared reconciliation is implemented.
- Atomic maximum 50 operations / 256 KiB batch. Server-derived deterministic IDs; no owner or arbitrary snapshot fields.
- Existing authoritative transactions, stable command identity, CAS/rebase, ledger receipts, projection invalidation and scoped undo.
- Reversible archive: full before/after object compensation in the existing owner-scoped command ledger. Undo preserves audit history and restores original collection order; newer target changes or live references block restore. No physical purging and no new snapshot format in this batch.
- Explicit version-2 per-account/per-OAuth-client management grant evaluator. Resolver is absent by default, so no existing production endpoint gains management permission. No database migration, live grant or OAuth setting is changed.

Intentionally still pending:
- Persistent consent/grant storage and its user-facing upgrade flow, token resource/scope audit, disconnect/revocation UX.
- Management MCP registration/read transport, archive browser and restore-by-receipt UI, consumer package submission.
- Other business domains; complete rule/preference field coverage; derived/scheduled action management must reuse existing domain/schedule operations.
- Real file/material storage and retention.

These boundaries are enforced in schemas and code, not merely described in tool instructions. Existing v7 and PR216 commands remain compatible.

Executable acceptance coverage includes schema injection, atomic rollback, missing targets, referenced-parent protection, safe manual-only action handling, unchanged-patch no-op, original ordering on restore, conflict with newer data, capability/account/client/revocation gate, default-deny before DB access, command replay/hash mismatch, transaction receipts and authorized/denied undo. All fixtures are synthetic.

## Authorization race boundary

Management grants are reloaded at initial admission, before each retried management attempt and immediately before an execute/undo mutation. Controlled tests revoke after the initial check, before undo commit and after a transient commit conflict; all refuse a write. This prevents stale in-process grant reuse but is **not** atomic revocation enforcement: a revocation can still race the network gap between the final read and the database commit. Production management must remain disabled until the grant identity/version and active account/client ownership are checked under the same transaction/lock as the authoritative mutation RPC. Do not wire the resolver to production and claim immediate revocation safety merely from the preflight tests.

## Derived preparation boundary

The existing Prep Graph enrichment recalculates graph leverage and some read fields, but does not reconcile materialized action titles or duration. The first batch rejects an update to Prep with dependent actions or schedule nodes instead of silently leaving those projections stale. A subsequent reconciled reducer must capture every dependent action/schedule change in affected-object receipts and compensation before enabling that case. Existing v7 specific domain commands remain the supported path for derived/scheduled Action changes.
