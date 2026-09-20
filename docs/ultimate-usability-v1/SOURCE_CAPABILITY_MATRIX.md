# Ultimate Usability v1 — Source Capability Matrix

Status values here are product contracts, not claims that all capabilities are already active.

| Source | Current/target role | Read | Write to PJSDAS | External action | Required policy |
|---|---|---:|---:|---:|---|
| PJSDAS Web natural language | first-party intake | n/a | target yes | no | shared semantic intake |
| PAIA owner ChatGPT input bridge | owner first-class adapter | authorized user inputs | target yes | no | OA-01; relevance/context minimization |
| ChatGPT MCP current conversation | explicit app/tool interaction | bounded reads | bounded semantic commands | no external recruiting action | existing auth + shared domain policy |
| Gmail recruiting source | trusted observation adapter | read-only | target autonomous facts | no send | source grant, structured validation |
| Discovery | candidate/source adapter | public/trusted source read | opportunity/source updates | no apply | identity + quality/source gate |
| ChatGPT Tasks | reminder/mapping channel | capability-probed | only through shared business semantics | task create/update only if authorized | never business truth |
| Google Calendar | optional schedule/reminder channel | capability-probed | mapping/outbox only | calendar operation only if authorized | ScheduleNode remains truth |
| iPhone text/dictation/share | future first-party intake | local user input | target yes | no | same Semantic Intake Contract |
| Manual forms | fallback/correction | n/a | yes | no | low-frequency escape hatch |

## Gmail target capability

- broader recruitment backfill than historical seven-day INBOX-only scan;
- archived recruitment mail coverage;
- push/history + compensation polling;
- idempotent pagination/watermark;
- multi-event messages;
- structured time/location/link/deadline extraction;
- attachment/link support matrix;
- explicit coverage gaps.

## Owner PAIA boundary

- only original user input is a trusted observation source;
- AI replies are not required as factual input;
- project/context is provided only as needed for disambiguation;
- quotes/examples/hypotheticals/rewrite requests must not auto-write;
- PJSDAS remains responsible for target identity, evidence, write policy, CAS and receipt.

## Unsupported-capability rule

If an external service cannot read/update/pause/subscribe reliably, record `NOT_SUPPORTED`.
Do not present a manual export/shared link as live synchronization.
