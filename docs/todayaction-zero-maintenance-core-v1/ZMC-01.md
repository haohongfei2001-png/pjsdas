# ZMC-01 — Time planning candidate

## Product behavior

Today reads the account-owned time preference from the workspace snapshot. A user can set a usual daily duration, optional weekday work windows, and a one-day override. Missing availability remains unknown; it is never silently interpreted as three hours. The Web Today read model shows one ranked flexible action when capacity is unknown, then packs hard deadlines and flexible actions within known capacity. Flexible overflow stays in the workspace and does not create a warning. Fixed commitments reserve time in the user's work windows and retain their ScheduleNode record. Only overlapping fixed commitments or physically impossible hard deadlines create a business conflict.

The preference is optional in snapshot v4 and stored under the existing IndexedDB `meta` store, so older snapshots remain valid. Connected edits use idempotent account commands. Command object references distinguish the default, weekly windows, and each date override so unrelated day edits can rebase independently. Imports preserve the preference. No production workspace was changed during this phase.

The legacy external TodayBrief and AI read contracts retain their shape and treat unknown availability as `null`; the numerical maximum used internally to compute a capped brief is not exposed as a user preference. They read the snapshot preference before any gateway-supplied legacy default.

## Red-before evidence

Before implementation, the owner fixture with 60 due-today flexible tasks selected 1,800 minutes of work for 2-hour, 6-hour, and 8-hour capacity. A second fixture admitted 30 flexible tasks into a 2-hour day. Overlapping fixed interviews produced no conflict. All five initial regressions failed against the phase baseline.

## Green-after evidence

- Unit regression covers 2/6/8-hour capacity, flexible overflow, overlapping interviews, cross-midnight clipping, genuine deadline infeasibility, work windows, snapshot and command persistence, invalid preferences, and unknown availability.
- Full unit suite: 208 files and 1,069 tests passed locally after independent-review repairs.
- TypeScript and production build passed locally.
- Headless Chromium could not launch in the local macOS sandbox (`MachPortRendezvousServer: Permission denied`); the same tests are included in the PR's cloud Browser E2E gate.
- First cloud exact-head run found fixtures still assuming hidden three-hour capacity and a warning for a physically feasible future deadline. Those assertions now use explicit capacity or a genuinely infeasible deadline. Independent review found and drove repairs for latest-start visibility, shared-choice deadlines, occupied work windows, and requested-date timezone resolution.

## Remaining gates

Exact-head CI, cloud Browser E2E, Matrix, independent review, merge, and exact-main readback remain required before this phase is marked complete.
