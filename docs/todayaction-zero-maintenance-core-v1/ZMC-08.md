# ZMC-08 — Settings and rare recovery

## Product contract

Normal connected Settings shows account identity, sync status, and the last useful update time. Technical sync terms, manual controls, and raw diagnostics live under Advanced diagnostics / recovery. A genuine unresolved difference still offers one clear route to inspect the issue without writing either copy. Whole-workspace choices are nested under Disaster recovery, explain the possible loss of unique job-search facts and history, and require explicit confirmation. They are never presented as routine conflict resolution.

## Red-before evidence and regression

- The connected Settings browser regression failed before the UI change: the state read `已登录` instead of `同步正常`, and routine copy described the browser's working copy and sync mechanics.
- A real local edit plus advancing remote revisions continues to preserve the edit and track the latest remote version. The browser regression now verifies that no whole-workspace choice is visible by default, the read-only inspection route is visible after opening advanced diagnostics, and disaster recovery requires a second deliberate disclosure.
- Existing connected pending-edit and sign-out regressions remain active. Manual sync feedback stays inside the advanced area; blocked sign-out still explains the local data risk once, without duplicate error banners.
- Independent review found that a simplified coded-error message pointed to Advanced diagnostics without showing the original error there. Coded errors now keep the plain routine message and expose the original detail only inside Advanced diagnostics.
- A follow-up independent review found two more status gaps. Signed-out coded errors now provide their own expandable detail, since Advanced diagnostics requires an account. Settings checks the actual local workspace against its account checkpoint before claiming sync is current; a local edit with automatic sync disabled shows `待同步修改` across a reload. The headless browser regression uses a real IndexedDB edit and preserved checkpoint.
- The same review caught the supported non-transactional connection mode: it has no local fingerprint check, so a valid synced checkpoint must keep its normal connected status instead of waiting forever for a check that will not run.
- Full-diff review caught an additional signed-out failure path: session restoration can put a coded error in the cloud context before a user exists. Signed-out Settings now exposes that connection error in a local disclosure, without requiring the account-only Advanced section.
- The macOS VoiceOver preparation gate failed before its browser test on three exact heads because the runner could not write the user TCC database. Guidepup's `--macos-ignore-tcc-db` bypass reached the browser test but then VoiceOver could not be activated; a single fresh-runner retry reproduced that failure. The real VoiceOver job now targets the supported macOS 14 image and uses full permission setup. Actual screen-reader success remains a required gate.

Full local and exact-head gates, independent review, merge, and exact-main production readback are pending. No production business records were changed.
