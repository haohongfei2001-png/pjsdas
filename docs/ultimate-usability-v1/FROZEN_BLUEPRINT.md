# PJSDAS Ultimate Usability v1 — Frozen Product Blueprint

Status: **FROZEN_DESIGN / NOT_IMPLEMENTED**  
Package: `PJSDAS-ULTIMATE-USABILITY-v1`  
Blueprint: `1.0`  
Audited source baseline: `main@bf0643eda139125868a9c697b81ff5ac5288a4f4`  
Product origin: `https://todayaction.com`

This is the repository-registered product/interaction contract derived from the owner-supplied
Ultimate Usability blueprint. It must be read together with `OWNER_AMENDMENTS.md`.

## 1. North Star

Within five seconds the user should understand:

1. what is most worth doing now;
2. the important schedule constraints in the next 48 hours;
3. whether anything genuinely requires a decision.

Routine facts should flow into the system without maintenance work.

The product optimizes for decision correctness and action clarity, not clicks, session length,
number of cards, or number of tasks created.

## 2. Product principles

- **Action before management.** The primary CTA enters the real action when possible.
- **Facts flow automatically; decisions remain human-owned.**
- **One real-world node has one business identity.** Multiple sources are evidence, not duplicates.
- **Quiet is not concealment.** Noise disappears; material uncertainty and conflicts remain visible.
- **Simple by default, evidence on demand.**
- **Continuity matters.** Background updates must not destroy draft text, navigation, selection,
  scroll position, or an action already in progress.
- **Empty space is preferable to low-value status information.**

## 3. User mental model

The user should only need to think in three concepts:

- **Today** — what to do now and what is about to happen.
- **Opportunities** — what is worth pursuing and what is already in progress.
- **Tell PJSDAS…** — report facts/plans/questions in natural language.

“Needs your decision” is conditional, not a permanent inbox to clear.
Settings and history are low-frequency control/audit surfaces.

## 4. Final information architecture

### Persistent primary destinations

Only two daily destinations are persistent:

- **Today**
- **Opportunities**

Settings is accessed from the account/control area, not a daily tab.
Attention is shown only when one or more real DecisionRequests exist.
Schedule is part of Today, not a separate calendar tab.

Semantic routes:

- `/today`
- `/today/agenda`
- `/opportunities`
- `/opportunities/:id`
- `/capture`
- `/decisions`
- `/settings`
- `/history`

Routing is semantic: Mac Web, responsive iPhone Web, future native iPhone, GPT/MCP reads, and deep
links must refer to the same business objects.

## 5. Today: two dimensions, both visible

Today must simultaneously answer:

### Execution order

- one primary next action;
- usually 2–4 “next up” actions;
- why now;
- real deadline/start time where known;
- estimated duration clearly labelled as an estimate;
- a primary operation that enters the real action, not merely “mark done”.

### Time order

A visible agenda shows future recruiting schedule constraints:

- interviews;
- written tests / assessments;
- application deadlines;
- availability windows;
- follow-up checks;
- preparation triggers.

The agenda is not a general calendar. It is a job-search time model.

Wide Mac: action column + agenda column.  
Single-column/iPhone: title → next action → agenda summary → next actions.

A user must not scroll past several tasks just to discover tomorrow’s exam.

## 6. Today action behavior

Primary CTA depends on the domain action:

- application → open verified application entry;
- written test / interview → join/open when a real target exists;
- preparation → begin the minimum-output preparation context;
- result check → automated check first where supported, otherwise human login;
- application-group choice → compare constrained opportunities.

Opening a website never implies applied.
Opening an exam never implies completed.
Leaving PJSDAS must not force a return-confirmation modal.

If there is no executable action, Today may be quiet. Future agenda nodes move up naturally.

## 7. Agenda semantics

Default summary window: next seven calendar days.  
“All schedule” default: next 30 days, with deeper loading on demand.

Temporal shapes must remain distinct:

- fixed range;
- availability window;
- hard deadline;
- date-only deadline;
- estimated date;
- system follow-up;
- prep trigger.

Do not fabricate 23:59 when only a date is known.

A recruiting process needs orthogonal state:

- stage;
- progress within stage;
- process result;
- user participation state;
- schedule-node state.

Example: “written test completed; waiting for result” is not the same as process completed.

Schedule node lifecycle:

`scheduled → in_progress → completed/cancelled/superseded`

Past time without completion evidence becomes `elapsed_unresolved`, never auto-completed.

## 8. Opportunities

The default product question is not “show me all database rows.”

Primary views:

- **In progress**
- **Worth pursuing**

Search/filter gives access to all/ended opportunities.

Rows should communicate:

- company + role;
- human-readable stage;
- next move;
- material deadline/node;
- one or two decision reasons/risks.

Fit/value internals, IDs, source health counts, and quota fields stay hidden unless they change the
decision.

New discovery candidates may be numerous; Today actions must remain sparse. Adding an Opportunity
must not automatically create a same-priority “apply today” task.

## 9. Opportunity detail

First-screen order is frozen:

1. conclusion;
2. main reasons / risks;
3. current process state;
4. next step + primary operation;
5. nearest relevant schedule node.

Then progressively reveal:

- role facts;
- eligibility/application constraints;
- preparation;
- source evidence;
- assessment breakdown;
- full history.

Use one shared decision read model so Today and Opportunity Detail cannot recommend contradictory
next moves.

## 10. DecisionRequest instead of maintenance queues

User-facing “Attention” is modeled as `DecisionRequest`.

Every request includes:

- natural-language question;
- why the user must answer;
- 2–4 concrete choices;
- recommended choice and basis where possible;
- consequence of each answer;
- related objects/evidence;
- answer deadline if material.

Lifecycle:

`open → answered / auto_resolved / superseded / expired`

Do not expose ChangeSet JSON, operation counts, sync retries, ordinary source refreshes, or internal
health queues as user decisions.

## 11. Unified “Tell PJSDAS…” entry

The product has one natural-language input model across Web, owner ChatGPT/PAIA intake, future
native iPhone, and compatible source adapters.

Pipeline:

`input → interpretation → identity/event resolution → field/evidence validation → policy →
atomic domain command or DecisionRequest → receipt → Today/Agenda/Opportunity projection`

Queries, examples, quotations, hypotheticals, and rewrite requests must not write facts.

One sentence can contain several facts. Independent clear facts can commit; ambiguous fragments
must ask only the missing question.

## 12. Automation architecture

All sources converge into the same intake contract:

`Source Adapter → SourceObservation → bounded interpretation → identity + semantic dedupe →
write policy → atomic domain command / DecisionRequest → mutation kernel/CAS/ledger/receipt →
read models/outbox`

No source adapter may implement its own business transition rules.

Minimum observation identity includes:

- source kind/account/record/version;
- observation/receive/asserted event time;
- source timezone;
- source reference;
- evidence fingerprint;
- interpretation version;
- field-level evidence;
- authorization grant ID where applicable.

Source content never expands permissions.

## 13. Gmail

Target architecture:

- read-only Gmail scope;
- encrypted server credentials;
- push/history where supported plus periodic compensation;
- first-use recruitment backfill broader than the historical seven-day INBOX-only behavior;
- recruitment mail outside INBOX must not be silently missed;
- structured extraction of application confirmations, invitations, completion receipts, reschedules,
  cancellations, rejections, offers, result messages, times, locations, links, and deadlines;
- one message may contain multiple nodes;
- replay must be idempotent;
- delayed old mail must not roll process state backward;
- attachment/link support must have an explicit support matrix;
- unsupported material gaps must be visible, not silently ignored.

## 14. GPT / PAIA / Tasks / reminder boundary

The generic product relies only on actually authorized ChatGPT app/MCP capabilities.

For the owner deployment, `OWNER_AMENDMENTS.md` promotes the PAIA user-input bridge to a first-class
source adapter.

Business time facts are `ScheduleNode`.
Reminder policy is `ReminderIntent`.
External GPT Task / Calendar objects are delivery/mapping channels, not business truth.

A task firing, pausing, expiring, or being deleted never means a written test/interview/application
has been completed.

## 15. Automatic write policy

Automatic commit requires all of:

1. authorized source/client/capability;
2. clear current fact or intent;
3. unique target and occurrence;
4. required fields + evidence present;
5. no unresolved material conflict;
6. compensatable update with no new external consequence.

Typical auto-writes:

- applied;
- written test completed;
- interview completed;
- explicit invitation/time/location/reschedule;
- rejection/offer received as facts;
- ordinary task completion;
- temporary “I only have 20 minutes now” plan override.

Do not automatically perform external submissions, withdrawals, email sending, offer acceptance or
rejection.

Object confidence, event-type confidence, and temporal confidence are separate. A single high
average score may not hide an uncertain critical field.

## 16. Mac and iPhone

### Mac

- compact sidebar with Today / Opportunities;
- top toolbar for capture, conditional DecisionRequest entry, account/settings;
- wide Today: action + agenda;
- Opportunity list with non-modal inspector;
- Cmd+K command/capture/search entry;
- hover may add convenience but never be the only way to act.

### iPhone

- only Today / Opportunities as stable bottom tabs;
- compact “Tell PJSDAS…” trigger above the tab bar;
- Opportunity detail uses push navigation;
- small clarifications use sheets;
- no sheet-on-sheet stacks;
- support safe areas, keyboard/input composition, large text, VoiceOver, Reduce Motion.

Native iPhone must use the same backend/domain/read models; no second iCloud/local business authority.

## 17. Visual system

- content-first, typography-first;
- neutral backgrounds;
- separators/whitespace before cards;
- restrained capsules;
- one primary accent;
- red only for blocking risk;
- material/glass on navigation, toolbar, popover, sheet — not every task;
- Web uses system font stack; native uses dynamic system type;
- normal text contrast ≥ 4.5:1;
- primary targets ≥ 44×44;
- focus visible;
- no state conveyed by color alone.

## 18. UX hard gates

Representative release gates include:

- user can state the next action + reason within five seconds;
- next hard schedule node is visible without visiting another module;
- ≥95% of facts satisfying the auto-write contract require no second confirmation;
- median manual maintenance actions for already-covered facts = 0;
- no meaningless “0 / none / latest sync” cards;
- 390×844 default type shows complete next action plus at least one upcoming node;
- no duplicate reminders managed by PJSDAS for the same node/purpose;
- wrong account/opportunity/occurrence write is release-blocking;
- late old facts may not regress process state;
- date precision may not be invented;
- replay may not create duplicate business facts;
- UI may not say “saved/completed” before durable persistence.

Autonomy accuracy must be measured on held-out evaluation data. Small demos do not justify broad
automatic write activation.

## 19. Target contracts

### ScheduleNode

Stable occurrence identity, opportunity/process relationship, kind, lifecycle state, temporal
shape, precision/timezone/raw expression, constraint kind, estimate provenance, evidence refs,
related actions, supersession/completion links.

### DecisionRequest

reason, objects, natural-language question, choices, consequences, recommendation, evidence,
payload/version binding, expiration, resolution.

### ReminderIntent / ExternalLink

node/version/purpose, delivery owner, channel/capability mapping, external ID, schedule, state,
dedupe key, receipt/retry state.

### TodayBrief

contract version, workspace revision, evaluation time/timezone, nextAction, nextActions,
agendaGroups, relevant DecisionRequests, material coverage warnings, internal diagnostics hidden
from default UI.

## 20. Round plan

- **UU-00** — register/freeze/revalidate design and compatibility contracts.
- **UU-01** — ScheduleNode, occurrence identity, progress/result/time semantics, migration adapters.
- **UU-02** — unified semantic intake, identity resolution, atomic complete/reschedule,
  DecisionRequest, shared write policy.
- **UU-03** — TodayBrief + Agenda + executability / latest-start model.
- **UU-04** — Web shell + final Today across Mac/iPhone-responsive Web.
- **UU-05** — Opportunities + conclusion-first detail.
- **UU-06** — Gmail + Discovery automated intake closure.
- **UU-07** — ChatGPT / reminder integration and external capability probing.
- **UU-08** — native iPhone client on the same contracts.
- **UU-09** — full canary, migration/rollback rehearsal, evidence-backed release gates.

No round may be skipped because a later UI is easier to demo.
