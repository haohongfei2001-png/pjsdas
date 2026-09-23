# CGR-02 — Today Vertical Slice production closure

status: `COMPLETE / PASS`

## User-visible result and remaining limit

A user can now open Today, explain a known fact through Tell PJSDAS, review the interpretation, save through the authoritative command path, see the result in another session, and Undo it after an unrelated later update without losing that later update. Before this slice, Today and capture did not form that coherent, receipt-backed daily journey.

The final Today shell also presents quiet, dense, fixed interview, date-only deadline, DecisionRequest, loading, cached-refresh failure, pending, unknown-save, offline, conflict and session-expiry states with a bounded next action. Production certification used synthetic facts and a dedicated temporary identity; it did not collect or publish private recruiting content. A formal release or public publication was not performed.

## Engineering and exact runtime

- Candidate PR #123, head `ee2031667952fdee44b711ba7f4f5f58b980237a`; original integrated runtime `cb98205edaaf5c71b99a33cb751310b3226657f2`.
- Engineering evidence and reviewed desktop, phone, large-text and degraded visual baselines: `CGR-02-ENGINEERING.md`. That receipt remains the historical engineering checkpoint, not a production PASS.
- Final exact integrated and deployed runtime: `408faba1b34f31614dba8c5ec84b656c8dca9866`. Main CI run `35885138153` SUCCESS; Browser E2E run `35885138195` SUCCESS. Production deployment `6618401666` SUCCESS, and the canonical `/api/health` reported this exact SHA with transactional workspace authority before certification.
- The only runtime-adjacent change between the original slice integration and final SHA repaired the synthetic canary runner: it sends the already required first-party Origin, initializes a new empty synthetic workspace through the existing explicit bootstrap, and guards identity recovery against command-ledger and workspace state. It did not relax server authorization, privacy, data integrity or migration checks. PR #129 candidate CI run `35884757178` and Browser E2E run `35884757197` passed; Vercel preview was rate-limited and was not counted as production evidence.

## Frozen production canary

Manual workflow run `35885667760` completed SUCCESS on the final exact runtime. After a matching production health preflight, it created one random dedicated synthetic account with a temporary beta audience grant and two distinct same-account sessions. Through the real first-party authoritative workspace endpoint, it initialized an empty workspace, saved two synthetic statements, recovered both durable command receipts, observed the first save in the second session within **7,391 ms** (under the frozen 15-second target), Undid the first after the second, then Undid the second. The final read verified neither synthetic action remained. The workflow revoked the audience grant, globally signed out, and deleted the temporary identity. It reported `commandCount: 2`, `receiptCount: 2`, `undoCount: 2`, `cleanup: verified` without exposing tokens or statement bodies.

An earlier run `35883702486` failed HTTP 403 before any command because the QA runner omitted Origin. The server's first-party guard correctly rejected it. The temporary grant was revoked and sessions signed out. Guarded recovery run `35885176459` verified that account's identity, revoked grant, **zero** command-ledger records and unchanged workspace, then deleted only that account. The failed run is preserved as failure evidence and is not a PASS.

## Preserved boundaries and continuation

The CGR-01 authoritative command, CAS, receipt, Undo, source authorization and rollback invariants remain in force. Legacy Today/capture paths were retired in the engineering checkpoint; no old snapshot writer was restored. The production canary is a synthetic command-path certification, while the reviewed browser, accessibility, responsive and failure journeys are exact-head engineering evidence. CGR-03 was already running under the permitted one-phase overlap and remains the sole active engineering phase; it is not marked COMPLETE by this receipt. CGR-04 waits for CGR-03's own phase closure. Publication, new external authority and paid services remain outside this closure.
