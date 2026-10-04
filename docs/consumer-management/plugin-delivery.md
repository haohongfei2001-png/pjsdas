# Consumer plugin delivery and activation

This is the current handover entry, updated 2026-10-05. Historical slice documents describe their implementation stage; they are not blanket live-availability claims.

## Current production boundary

The approved eight migrations from 9055fa21 are installed after an actual encrypted production backup was restored and verified offline. Every complete file and history record committed in one native transaction with lock_timeout=2s and statement_timeout=15s; independent final catalog/permissions/history readback passed. Temporary maintenance roles/tokens were removed and old credentials rejected. See [production migration result](production-migration-result-2026-10-04.md).

The approved two-identity business-v7 test completed its core original-host journey and has been cleaned up. Read [controlled host results and cleanup](controlled-host-result-2026-10-05.md) for exact passes, the retained undo conflict, the host-blocked stale undo, and remaining acceptance gaps. Consumer flags are off, both identities are banned and revoked, and public installation remains unverified. OAuth clients were not changed and publication was not performed. Developer testing does not require the owner to supply two emails, switch accounts or run acceptance. Database maintenance is no longer blocked on a user-provided password.

## What exists

The source implements empty-workspace onboarding, explicit timezone selection, separate five-domain consent, read/write/undo or restore, revocation, uncertain-result recovery and account-switch protection. Business consent is **v7**, separate from owner-only v2. The controlled consumer runtime registers only business v7 for exactly two configured beta account UUIDs and the verified original client; other domains remain outside this test. Owned revocation is available even with all admission flags disabled. See [controlled-v7-review.md](controlled-v7-review.md). No old grant is upgraded.

The canonical production MCP address is `https://todayaction.com/api/mcp`. After PR245/246 and controlled-test cleanup, the production health response identifies `7901fdd64293f375dd8c51e8e849a2f8a6426679`, with `allowlist` audience mode and consumer flags restored off. A health `migrationSet` lists source files; it does **not** prove those migrations are installed.

Read the bounded contracts: [first batch](batch-1.md), [business v7](business-v7.md), [planning v4](../management/planning-v4.md), [discovery profile v5](../management/discovery-profile-v5.md), [private reminders v6](../management/private-reminders-v6.md), and the broader [target contract](contract.md). Derived-object reconciliation, external reminder delivery, materials and other unfinished matrix rows remain outside the completed slices.

## Rebuild the candidate

`plugins/todayaction/` is the versioned source. It was rebuilt from accessible repository material; no previous local draft is claimed as received. It contains a portable `plugin.json`, one `streamable-http` declaration in `mcp.json`, and existing approved TodayAction PNGs. No app mapping, OAuth secret, reviewer credentials, user ID or lifecycle hook is included.

```sh
python3 scripts/package-consumer-plugin.py --output /tmp/todayaction-candidate.zip
python3 tests/plugin-package/test_package.py
python3 scripts/package-consumer-plugin.py --require-submission-metadata
```

The first command builds reproducible bytes and reports SHA-256. The last command intentionally fails until missing publisher, support, privacy, terms and demonstration fields are supplied. Source policy validation is not the platform's package validator, an OAuth scan, installation acceptance or approval to publish. Do not upload until the existing portal identity has been established.

The candidate includes five positive and three negative review scenarios. They are **test specifications, not completed host receipts**. All five positive scenarios require an admitted dedicated account and explicit business v7 consent. The three negative specifications cover unsupported permanent deletion, external recruiting actions and paid/background discovery; isolation and revocation are tracked separately as safety acceptance. The description truthfully says access is restricted and consumer management is not publicly enabled. Update that statement only after the actual enablement gate passes.

## Verified missing publication inputs

- `/privacy`, `/terms` and `/support` returned HTTP 404 on the canonical origin on 2026-10-03; no versioned policy/support page or package was present at the reviewed head. These are observed missing paths, not a claim that no alternate policy URL exists.
- The current signed-in host personal directory lists TodayAction under “由你创建”, with observed detail URL `https://chatgpt.com/plugins/plugin_asdk_app_6abfbe4dea888191ad2c6a28af430d32?directoryTab=personal`. This is an observed plugin detail reference, not a verified backend edit ID. Its first detail load reported `cloudflare_challenge`; one normal reload succeeded. The existing connected host management view confirms OAuth, `https://todayaction.com/api/mcp`, DEVELOPMENT status, application `asdk_app_6abfbe4dea888191ad2c6a28af430d32` and version `asdk_app_v_6abfbe4dea908191abb88db3f633acab`. Mapping to the handed-over installed reference `dev-6aabd85e5ae08191ac65ca9ac975c400@openai-curated-remote`, the submission edit record and publication history remains unverified. The host account and portal account were subsequently matched through visible signed-in account information without retaining the email. An actual pending OAuth request initiated from the original host entry was correlated to its existing client by a SHA-256 authorization-reference comparison; no OAuth client was created or modified and no identity or consent was submitted. Public plugin search still returns no result; no duplicate was created.
- The in-app browser now works and the existing Supabase/Vercel sessions plus the signed-in host plugin management page were inspected. The host management URL is `https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6abfbe4dea888191ad2c6a28af430d32`. This is not a verified submission-portal edit ID or publication history. No external visible browser or duplicate plugin was created.
- The two developer test identities are now revoked and banned; they are not usable long-term reviewer accounts. Actual host core-operation receipts exist in the controlled results, but no reviewer-accessible recording is complete. Do not use the owner's private account as a reviewer fixture. Reviewer credentials belong in the secure dashboard form, never a ZIP, Git commit, screenshot or public issue.

Resolve these through the existing publisher account. Do not guess an ID, replace a domain challenge, create a second plugin, issue real grants or reconnect users to force a scan. The exact controlled audience and flags are approved for this bounded test; broader admission, OAuth edits and publication remain unapproved.

## Real-host acceptance after controlled activation

Use the **existing** plugin entry and the publisher's supported draft/update mechanism. Record its real edit ID, organization/project, package digest, scanned catalog revision and host name/version. Use two dedicated synthetic accounts A/B and sample data under the exact server-only cohort/client configuration. Use the original plugin owner account, never a duplicate plugin. Secure reviewer access details stay outside this repository.

1. Install in a fresh host session. Observe actual OAuth login, return URI, cancellation and resume; a direct backend call is not a substitute. Confirm the catalog from the installed connection. Record which tools are visible, held or absent. The 2026-10-04 existing-host catalog was observed with 25 tools (17 reads, 8 writes), without consumer v7 tools. This is an existing-connection observation, not fresh-install acceptance.
2. Log in as A. Open `https://todayaction.com/?connect=1`. Create a blank workspace with a deliberate IANA timezone, or connect existing data without reset. Existing Local/Drive data keeps its explicit migration decision. Verify duplicate clicks create no duplicate workspace.
3. Select the actual OAuth client. All five scopes initially stay unchanged. Approve only business v7; planning v4 and all other domains are outside this controlled test and require separate future consent; verify the exact change summary and unselected scope denial. Close/Back/Forward and interrupted login must not submit a decision.
4. Run all five positive cases from the manifest in the installed host. Preserve command IDs, receipt references and before/after values. Read back from the web UI and host. Replay the same request once and verify no duplicate object/ledger mutation. Undo the exact unchanged target; a newer edit must conflict.
5. While a request is pending, switch to B. Verify no A data, receipt, consent choice or cached result is presented as B's. Foreign object/receipt identifiers must not disclose existence. Repeat close/reopen and login recovery.
6. Revoke through the first-party page. Installed-host reads/writes in that scope must fail afterward. Exercise a controlled write/revoke race using only synthetic data, distinguishing a write committed before revocation from a stale request after it. Regrant must not revive the old request. Revoke remains possible for disconnected/stale-text grants.
7. Run the three negative cases, then capture desktop/mobile screenshots and a walkthrough. Record exact deployed SHA and unchanged production defaults/public audience. A mock transport, SQL fixture or public health response cannot mark this gate complete.

The walkthrough should show installation, OAuth, workspace/timezone, scope choices, actual read/write/replay/undo, revocation, denial and account isolation in that order. Until recorded, omit the demo URL instead of inventing one.

## Publication boundary

Format and submission requirements were checked against [OpenAI package documentation](https://developers.openai.com/plugins/build/plugins) and [submission documentation](https://developers.openai.com/plugins/deploy/submission) on 2026-10-03. Publisher verification, policies, reviewer access, domain challenge, actual OAuth/tool scan, executed cases and approved publication remain independent gates. Passing source tests or uploading a candidate does not satisfy them.

## Review follow-up and developer-owned testing (2026-10-04)

PR241 retained two outstanding review findings. The follow-up moves the native backup regression to a separately initialized PostgreSQL 17 cluster, checks a different system identifier, proves database-only restoration fails when required roles are absent, and then restores password-free role definitions and memberships before comparing catalog, ACL, rows and history. Membership comparisons now include grantors. Production migrations and backup receipts are not rerun or rewritten.

The local preparation page is read-only. Both historical password and A/B email POST endpoints return 410 without reading or storing input. Direct invocation defaults to the checkout, with an actual subprocess regression in a temporary checkout. The page no longer asks the user to operate developer QA.

The approved test scope and cleanup requirements are in [controlled-v7-review.md](controlled-v7-review.md). The original submission portal is [OpenAI Plugins](https://platform.openai.com/plugins); always use the original plugin owner account and verify the existing record before any upload. On 2026-10-04 the available saved Apple login reached the portal, but its sole Personal organization / Default project listed no plugins. This is not evidence that the original host plugin is absent or owned by a different account; the existing submission record remains unconfirmed. Subsequent visible account checks confirmed that this is the original host account. No new record was created or package uploaded. An initial later host-detail navigation failed, then a fresh built-in tab recovered and the original management view was reached. The earlier observed 25-tool catalog remains historical evidence, not a new installation test.

Current official [submission requirements](https://developers.openai.com/plugins/deploy/submission) require sample reviewer access without interactive codes, executed positive/negative cases and an actual walkthrough. The dedicated existing-provider login preparation is described in [reviewer-access.md](reviewer-access.md). No fabricated host receipts or policy publication are part of this follow-up.

PR242's final Chromium run completed with one retained first-attempt failure and retry pass in the journal transaction-count test. It observed the correct original row and queued final state, but counted two transactions while the entire app's recovery was active. The follow-up uses a same-origin document without mounting the app, imports the real database module, and keeps native IndexedDB, the queued competing writer and the exact one-transaction assertion. Transaction stacks are attached for diagnosis. All existing full-app recovery and account-race tests remain required; no assertion, retry limit, wait or performance threshold is relaxed.
