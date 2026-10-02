# Owner consent UI (inactive until separately approved)

This isolated entry at `?manage_access=1` consumes the first-party consent API from the parent change. It does not expose a Settings link, activate a feature flag, apply a migration, or create a grant automatically. Existing OAuth `authorization_id` navigation retains priority.

## Explicit decision boundary

The page shows the verified account, provider-approved client choices, versioned scope, exclusions, duration and last-read grant state. The owner must select a client and confirm the displayed scope before approving or revoking. A fresh first-party session must still match the displayed account before POST. Duplicate clicks cannot submit a second request.

Uncertain responses preserve the exact request ID and decision in account-scoped session storage without tokens. A subsequent read is required before the owner can explicitly retry that same request. A receipt is historical, so the page rereads current state before describing the grant as active. Account changes, navigation and restored history invalidate stale views and confirmation choices. Compare-and-clear prevents an older document's receipt from deleting a newer pending request.

## Verification

- Client and pending-request unit tests cover strict response validation, account binding and exact-request recovery.
- The source lifecycle harness executes the actual component with synthetic hooks and transport. This is not browser evidence.
- Seven Playwright scenarios exercise deliberate decisions, repeated clicks, uncertain response recovery, close/back navigation, default-off behavior, desktop/mobile overflow and screenshots, restored-history refresh, and session loss across a full reload.
- At source freeze: 230 test files / 1404 tests, TypeScript and production build passed. PR #226 exact head fe1dc49e passed real Chromium CI: all seven new scenarios, 199 core and 67 dense journeys. The retained 1280/390 screenshots were inspected and are readable without horizontal overflow. Local browser access was blocked. The combined integration candidate must rerun exact-head gates. Live consent, grants and migrations have not been activated or tested.
