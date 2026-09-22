# Target Experience

## Global composition

The mature Mac Web product has a quiet persistent shell with two primary destinations: Today and Opportunities. Capture is globally available without becoming a third information architecture. Settings, support, history, and diagnostics remain low-frequency.

The shell preserves route identity, back behavior, keyboard navigation, selection state where appropriate, and predictable responsive transitions. It must not be another versioned wrapper layered over prior shells.

## Today

Today answers, in order:

1. Now — the single most useful action that can actually be advanced.
2. Next — near-term interview, test, deadline, or other commitment.
3. Alternatives — only a small number when the user has a meaningful choice.
4. Changes handled — concise high-value updates already incorporated.
5. Needs your decision — only unresolved business decisions.

A typical desktop composition uses a constrained content width with a primary Now column and a Next schedule column. Narrower layouts collapse without changing information priority.

The main action contains a human action label, opportunity identity, the most relevant time fact, one concise reason, and a real action target. A button is not a real action target if it merely changes an internal status or opens an unrelated generic page.

The schedule distinguishes fixed time, time range, deadline, and date-only precision. Elapsed time never silently means completion.

Completing an action updates the affected region without disorienting page jumps. Hard constraints remain visible. Today may be intentionally sparse.

## Opportunities

Each list item should communicate company/role identity, current process state, next important schedule fact, current next action or decision, and concise decision-relevant signal.

Search and filtering must not duplicate the same state model in multiple controls. Selection, filters, and return position survive routine navigation.

On suitable desktop widths, list/detail continuity may be used where it improves scanning. Narrow layouts use normal navigation rather than compressing two desktop panes.

## Opportunity detail

Information order:

1. identity and current progress;
2. next schedule node and next action;
3. key decision context;
4. recruiting timeline;
5. preparation and materials;
6. source/history details.

History labeled complete must expose complete history through expansion or pagination. A truncated list is labeled recent.

Corrections, completion, rescheduling, participation changes, and preparation work occur near the object they affect and use the shared command/receipt model.

## Tell PJSDAS

The input can be opened globally and from an opportunity or schedule context. When context exists, it is visible before submission.

Mixed input may produce multiple results.

A successful response names the interpreted effect, such as:

- Written test marked complete; recruiting process remains active.
- Interview moved to Friday 14:00; previous time preserved in history.
- Two roles at the same company match this statement; choose which one.

Feedback distinguishes interpretation from authoritative save. Undo and inspect links attach to the concrete receipt where available.

If text cannot be converted into a fact, the product says so plainly rather than using generic no-write wording.

## Decisions

DecisionRequests are business ambiguity, not a dumping ground for technical problems.

Each decision includes the concrete question, relevant identities, evidence summary, a recommended option when one is objectively safer or better supported, other valid choices, and consequences.

Routine retry, cache repair, revision reconciliation, parsing errors, and transport failures remain engineering concerns unless they create a real user choice.

## Prep context

Preparation is attached to opportunity and recruiting-event context. Users should not need to understand Prep as a separate internal subsystem to find interview preparation, company research, resume variants, or relevant material.

## Settings

Settings is organized around account, connections and automation, reminders, preferences, data and privacy, and support/diagnostics.

It does not expose internal authority choices as routine settings.

Connection state reports real capability impact, last useful successful processing time, and recovery actions. A green connected state alone is insufficient.

## Loading and degraded states

- Loading uses layout-preserving skeletons and never flashes a false empty workspace.
- Cached while refreshing keeps content/scroll visible and marks freshness quietly.
- Empty workspace offers a simple first useful action rather than empty modules.
- Pending authoritative save is distinct from saved.
- Unknown commit outcome says save status is being verified and resolves by receipt identity before retry.
- Offline keeps existing data readable and separates drafts/pending operations from authoritative state.
- Conflict auto-merges independent changes; true same-object contradictions show concrete facts/sources.
- Authorization failure explains which source stopped updating, last known success, and recovery.

## Visual hierarchy and craft

The target visual language is calm, durable, and information-led.

Requirements include one coherent type scale, semantic spacing, restrained surfaces/borders, consistent states, stable date/status alignment, no decorative cards without information purpose, no tiny copy used to force density, no global important-overlay layer as a design mechanism, and motion only for continuity/feedback.

Visual quality is judged on realistic dense workspaces, long names, Chinese/English content, and failure states.

## Responsive and accessibility behavior

Responsive behavior preserves priority rather than merely shrinking dimensions.

Evidence includes phone-class, tablet/transition, desktop, long content, large text, software keyboard conditions, safe-area/overlap checks, keyboard-only navigation, focus restoration, dialogs/sheets, and screen-reader semantics.

## Reference-design rule

CGR may freeze reference compositions, visual baselines, and interaction examples before implementing a slice. These specify production work; they are not a parallel full prototype to discard later.
