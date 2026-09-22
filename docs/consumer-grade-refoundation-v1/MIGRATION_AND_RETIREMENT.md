# Migration and Retirement

## Migration doctrine

Migrate incrementally through production-grade vertical slices. Preserve authoritative business data and history. Do not run two active business authorities for the same operation.

Typical order:

1. add compatible authoritative command/read contracts;
2. make server and existing domain logic support them;
3. add client command/read-model adapters;
4. shadow/compare behavior where useful;
5. move one real journey to the new boundary;
6. verify production behavior and recovery;
7. retire the replaced write/UI/style path;
8. repeat for the next journey.

## Daily connected write retirement

The whole-snapshot mutation/sync path is retired for ordinary connected actions as CGR-01 command coverage reaches them.

Whole snapshots may remain for bounded import, export, migration, backup/recovery, or diagnostic comparison. They must not remain a hidden parallel daily authority.

## Local persistence migration

Local storage becomes account-scoped cache, draft storage, and pending-operation storage.

Migration preserves safe offline-readable data, binds cached data to authenticated identity, prevents account-crossing display or mutation, migrates/discards obsolete pending entries deterministically, and retains receipt identity for unknown outcomes.

## Frontend migration

Routes are migrated by complete user journey, not by creating a new shell that embeds old pages indefinitely.

New primitives must not depend on old global CSS override order. Old components may be wrapped temporarily only with an explicit retirement target. Every migrated route records remaining legacy dependencies. No new feature is added to a retired surface except critical compatibility.

## CSS retirement

For each migrated surface:

1. identify active selectors/dependencies;
2. move required styles to final primitives/local feature styles;
3. verify visual/responsive states;
4. remove unreferenced legacy selectors/files;
5. prevent reintroduction through static dependency checks where useful.

Do not add another global polish layer.

## Route and entrypoint retirement

A daily-use legacy route is deleted or redirected once the new route covers the necessary outcome, bookmarks/deep links have a migration path, no supported client depends on the old write behavior, production evidence confirms the new route, and rollback does not require stale-snapshot restoration.

## Automation migration

Preserve source transport reliability while interpretation/feedback is refactored.

Use shadow interpretation and synthetic/redacted replay where appropriate. Autonomous commit is enabled only for the same or stricter already-authorized policy class unless a later owner decision changes authority.

## Legacy compatibility retirement gate

A compatibility path can be deleted when no supported consumer remains, preserved invariants have parity, rollback has a forward/compensating strategy, tests no longer require the path, deletion preserves authoritative history/provenance, and exact changed-path evidence is recorded.

## Real-data protection

Synthetic fixtures are the default.

Bounded real-owner canaries may be used when required to prove production integration. They must be non-destructive or compensatable, preserve receipts, avoid exposing private content in public evidence, and never perform external recruiting actions without explicit authority.

## Rollback

Preferred order:

- disable the new command/event class through a bounded kill switch;
- preserve reads and evidence;
- forward-fix;
- compensate affected mutations;
- revert client route if it can safely read current authoritative data.

Never restore an old workspace snapshot over newer facts.

## Package retirement target

By CGR-05, obsolete daily-use shells, duplicate mutation paths, unused CSS layers, and compatibility entrypoints identified by this package must either be removed or explicitly documented as supported compatibility with a concrete reason. “May still be useful” is not sufficient.
