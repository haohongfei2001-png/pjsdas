# Consumer plugin delivery and activation

This is the current handover entry, dated 2026-10-03. Historical slice documents describe their implementation stage; they are not blanket live-availability claims.

## What exists

The source implements empty-workspace onboarding, explicit timezone selection, separate five-domain consent, read/write/undo or restore, revocation, uncertain-result recovery and account-switch protection. Business consent is **v7**, separate from owner-only v2. The source runtime registers these capabilities only behind explicit flags and verified audience/account/client checks. No old grant is upgraded.

The canonical production MCP address is `https://todayaction.com/api/mcp`. On takeover, both backend health and remote main identify `4b1e2b0b3cde303246804ba3a0a8a45f577ba884`, with `allowlist` audience mode. Consumer activation is not performed by this delivery. A health `migrationSet` lists source files; it does **not** prove those migrations are installed.

Read the bounded contracts: [first batch](batch-1.md), [business v7](business-v7.md), [planning v4](../management/planning-v4.md), [discovery profile v5](../management/discovery-profile-v5.md), [private reminders v6](../management/private-reminders-v6.md), and the broader [target contract](contract.md). Derived-object reconciliation, external reminder delivery, materials and other unfinished matrix rows remain outside the completed slices.

## Rebuild the candidate

`plugins/todayaction/` is the versioned source. It was rebuilt from accessible repository material; no previous local draft is claimed as received. It contains a portable `plugin.json`, one `streamable-http` declaration in `mcp.json`, and existing approved TodayAction PNGs. No app mapping, OAuth secret, reviewer credentials, user ID or lifecycle hook is included.

```sh
python3 scripts/package-consumer-plugin.py --output /tmp/todayaction-candidate.zip
python3 tests/plugin-package/test_package.py
python3 scripts/package-consumer-plugin.py --require-submission-metadata
```

The first command builds reproducible bytes and reports SHA-256. The last command intentionally fails until missing publisher, support, privacy, terms and demonstration fields are supplied. Source policy validation is not the platform's package validator, an OAuth scan, installation acceptance or approval to publish. Do not upload until the existing portal identity has been established.

The candidate includes five positive and three negative review scenarios. They are **test specifications, not completed host receipts**. Four positive scenarios require controlled consumer activation. The description truthfully says access is restricted and consumer management is not publicly enabled. Update that statement only after the actual enablement gate passes.

## Verified missing publication inputs

- `/privacy`, `/terms` and `/support` returned HTTP 404 on the canonical origin on 2026-10-03; no versioned policy/support page or package was present at the reviewed head. These are observed missing paths, not a claim that no alternate policy URL exists.
- The verified publisher name, publication organization/project, existing portal edit ID and publication history have not been established. The supplied installed reference `dev-6aabd85e5ae08191ac65ca9ac975c400@openai-curated-remote` is not treated as a portal ID. Plugin search returned no accessible TodayAction result in this session; this does not prove the existing private plugin is absent.
- The current session could enumerate an in-app browser but could not create a usable tab; the requested portal tab was queued by Codex. No external visible browser was launched. No logged-in publication dashboard was inspected.
- No dedicated synthetic reviewer account or actual-host demo receipt is available in this checkout. Do not use the owner's private account as a reviewer fixture. Reviewer credentials belong in the secure dashboard form, never a ZIP, Git commit, screenshot or public issue.

Resolve these through the existing publisher account. Do not guess an ID, replace a domain challenge, create a second plugin, issue real grants or reconnect users to force a scan. The operator must authorize the exact controlled audience and flags separately.

## Real-host acceptance after controlled activation

Use the **existing** plugin entry and the publisher's supported draft/update mechanism. Record its real edit ID, organization/project, package digest, scanned catalog revision and host name/version. Use two dedicated synthetic accounts A/B and sample data. Secure reviewer access details stay outside this repository.

1. Install in a fresh host session. Observe actual OAuth login, return URI, cancellation and resume; a direct backend call is not a substitute. Confirm the catalog from the installed connection. Record which tools are visible, held or absent. The previously reported 25-tool connection is a handover fact, not a fresh catalog observation.
2. Log in as A. Open `https://todayaction.com/?connect=1`. Create a blank workspace with a deliberate IANA timezone, or connect existing data without reset. Existing Local/Drive data keeps its explicit migration decision. Verify duplicate clicks create no duplicate workspace.
3. Select the actual OAuth client. All five scopes initially stay unchanged. Approve only business v7 and planning v4; verify the exact change summary and unselected scope denial. Close/Back/Forward and interrupted login must not submit a decision.
4. Run all five positive cases from the manifest in the installed host. Preserve command IDs, receipt references and before/after values. Read back from the web UI and host. Replay the same request once and verify no duplicate object/ledger mutation. Undo the exact unchanged target; a newer edit must conflict.
5. While a request is pending, switch to B. Verify no A data, receipt, consent choice or cached result is presented as B's. Foreign object/receipt identifiers must not disclose existence. Repeat close/reopen and login recovery.
6. Revoke through the first-party page. Installed-host reads/writes in that scope must fail afterward. Exercise a controlled write/revoke race using only synthetic data, distinguishing a write committed before revocation from a stale request after it. Regrant must not revive the old request. Revoke remains possible for disconnected/stale-text grants.
7. Run the three negative cases, then capture desktop/mobile screenshots and a walkthrough. Record exact deployed SHA and unchanged production defaults/public audience. A mock transport, SQL fixture or public health response cannot mark this gate complete.

The walkthrough should show installation, OAuth, workspace/timezone, scope choices, actual read/write/replay/undo, revocation, denial and account isolation in that order. Until recorded, omit the demo URL instead of inventing one.

## Publication boundary

Format and submission requirements were checked against [OpenAI package documentation](https://developers.openai.com/plugins/build/plugins) and [submission documentation](https://developers.openai.com/plugins/deploy/submission) on 2026-10-03. Publisher verification, policies, reviewer access, domain challenge, actual OAuth/tool scan, executed cases and approved publication remain independent gates. Passing source tests or uploading a candidate does not satisfy them.
