# Mounted consumer recovery through the real API and PostgreSQL

This synthetic gate exercises the actual Today task-completion button and its
short-lived Undo button. Only initial business data and a synthetic signed login
are seeded. The UI creates every command ID, pending record and IndexedDB journal.
The saved local `autoSync=false` preference selects the existing 60-second outbox
recovery scheduler; no pending operation or checkpoint is injected.

The mock-cloud `.invalid` browser destination is bridged to loopback without
changing the method, Origin, Authorization, request bytes or API response. Each
request runs the original workspace/health handler in a cold process, which can
contact only the owned fixture's public PostgREST. PostgreSQL is genuine, with an
independent database and a temporary NOINHERIT, non-superuser authenticator. No
real OAuth, provider, email, external source or production account is contacted.
The globally mounted AI-access provider also performs its ordinary automation
status read. That read reaches the original API with the same JWT/Origin/body;
the native fixture's unchanged Google-binding ACL returns actual
`401/AUTH_INVALID`, which this gate explicitly records. No synthetic success,
Google connection, or broader fixture ACL/RLS is supplied. This is not an
automation-settings/Gmail health acceptance test.

Three separate cases require all assertions, with no retries or fake clocks:

1. Actual offline completion and Undo clicks within the existing toast lifetime;
   zero PostgreSQL mutation while offline; a new page in the same browser context
   automatically recovers both original IDs and their dependency after reconnect.
2. A successful API command and matching PostgreSQL ledger/revision are observed
   before its ACK is dropped. The old page exits, and a newly mounted consumer
   recovers the original committed receipt without another command.
3. The same committed-ACK fault leaves the original page online. After one failed
   immediate receipt lookup, only transport availability returns. No focus/online
   event, explicit replay call, clock advance or navigation triggers recovery; the
   existing 60-second interval must settle the receipt. Elapsed time must be at
   least 50 seconds, ruling out the initial 700 ms timer as the claimed proof.

All cases verify exact command IDs, one ledger entry per intended operation,
local confirmed journals, target state, unrelated-row preservation and absence
of a large-command prepared intent. Source manifests bind the native closure and
the actual browser journey, helper, config, HTML and health inputs. Cleanup and
source verification failures fail the case. Trace/video/storage-state/raw HTTP
and worker output are not uploaded; only sanitized results/source/cleanup are.
The aggregate also requires the complete browser runner's zero exit status, so
passing cases cannot mask a rejecting-proxy/global-teardown failure. Missing or
nonterminal cases, source mismatches and cleanup failures remain failed gates.

**Boundary:** this is the existing small-row `domain:set_action_status`/Undo path,
not durable-v2 large-command admission. It does not invent a consumer abandon
button or certify browser-originated v2 commands, hosted fallback, production
activation, ACL retirement, physical storage or prior deadline/long-task issues.
Gate implementation is not itself browser execution evidence. Read each exact
CI checkout/PR-head mapping and all three terminal case/cleanup results.
The dedicated `.consumer-pg.ts` journey is intentionally outside ordinary
`*.e2e.ts` discovery, and its PG fixture loads only inside its test body.
