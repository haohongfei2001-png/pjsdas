# Reliability scenarios

These tests exercise PJSDAS as a state machine across modules rather than as isolated functions.

- `harness.ts` projects a workspace into stable durable semantics.
- `autonomousReliabilityHarness.test.ts` contains cross-source and integrity scenarios.

Keep scenario inputs synthetic and non-identifying. When a real defect is found, reduce it to the smallest deterministic synthetic scenario and add it here before or with the fix.
