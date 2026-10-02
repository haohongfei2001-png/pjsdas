# Settings continuous-list adaptation

## Problem and design

The released Settings page repeats a large bordered card for the account and each background source. Ordinary success banners, descriptions and scattered actions dominate the first screen. This change uses the established Today/Jobs white panel, row dividers, typography and secondary text.

Connections become one continuous list with four distinct rows: account and cross-device data, background workspace connection, public-job discovery, and recruiting-email tracking. Normal sync uses quiet inline status and the last update time. Account management, logout and diagnostics live in an explicit disclosure. Preferences and data tools share a second list instead of separate cards.

Each source keeps its existing handler, independent status and disabled state. Permission descriptions remain visible before enable/authorization; existing connection scope remains reviewable. Connection failures, unsynced changes, incomplete source status and unresolved email outcomes remain visible. Details contain supporting diagnostics, not material warnings. No account grant, scope, storage or domain command changes are included.

## Acceptance evidence

Baseline: production main `1fa12d02ac5073bac0e82b419e1162d0ae84fdea`.

- Local: TypeScript/build and all 223 unit-test files / 1304 tests passed.
- Browser/pixel verification: pending exact candidate CI. Local browser launch is unavailable in this execution environment; no local browser pass is claimed.
- Existing Secondary UI workflow captures before/after Settings overview and expanded states at 1440px, 390px and 320px with 200% text. It requires unchanged main-page pixels.
- Source hierarchy journeys cover enabled, disabled, partial, failed and unverified states, long synthetic account identifiers, before-enable permissions, repeated disclosures, errors and mobile overflow.
- Account recovery, logout, Gmail boundaries and real VoiceOver journeys retain their existing behavioral assertions, with the added account/results disclosure step.

Actual desktop/mobile screenshots must be inspected before visual acceptance. All committed fixtures and CI screenshots are synthetic; no production workspace screenshot or private correction packet belongs in this package.
