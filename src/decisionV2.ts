// Compatibility entrypoint: existing application code and historical tests may
// continue importing decisionV2 while the single authoritative implementation
// lives in decisionV3.
export * from './decisionV3'
