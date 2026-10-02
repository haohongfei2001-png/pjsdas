# Settings continuous-list adaptation

## Problem and design

The released Settings page repeats a large bordered card for the account and each background source. Ordinary success banners, descriptions and scattered actions dominate the first screen. This change uses the established Today/Jobs white panel, row dividers, typography and secondary text.

Connections become one continuous list with four compact management rows: account and cross-device data, background workspace connection, public-job discovery, and recruiting-email tracking. Normal sync uses quiet inline status and the last update time. Account management, logout and diagnostics live in an explicit disclosure. Each source has its own Manage disclosure; enable, reconnect and disable controls live inside it. Full permission descriptions appear before the actual authorization or enable control. Preferences and data tools share a second list instead of separate cards.

Each source keeps its existing handler, independent status and disabled state. Permission descriptions remain visible before enable/authorization; existing connection scope remains reviewable. Connection failures, unsynced changes, incomplete source status and unresolved email outcomes remain visible. Details contain supporting diagnostics, not material warnings. No account grant, scope, storage or domain command changes are included.

## Acceptance evidence

Baseline: production main `1fa12d02ac5073bac0e82b419e1162d0ae84fdea`.

- Local: TypeScript/build and all 223 unit-test files / 1304 tests passed.
- Browser/pixel verification: Secondary UI run 37016161537 passed for product tree d0903063. Actual desktop, mobile, 200% text and error/expanded screenshots were inspected: normal connection rows are approximately 94px and the four-row panel approximately 418px. Main-page pixel comparisons passed. The successor only resets screenshot scroll position after disclosure checks; full exact-head gates remain pending. Local browser launch is unavailable in this execution environment; no local browser pass is claimed.
- Existing Secondary UI workflow captures before/after Settings overview and expanded states at 1440px, 390px and 320px with 200% text. It requires unchanged main-page pixels.
- Source hierarchy journeys cover enabled, disabled, partial, failed and unverified states, long synthetic account identifiers, before-enable permissions, repeated disclosures, errors and mobile overflow.
- Account recovery, logout, Gmail boundaries and real VoiceOver journeys retain their existing behavioral assertions, with the added account/results disclosure step.

Final exact-head desktop/mobile screenshots and full gates must be verified before merge. All committed fixtures and CI screenshots are synthetic; no production workspace screenshot or private correction packet belongs in this package.
