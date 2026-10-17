// Fixed older visual baselines and the existing explicit live smoke use the
// old production-shaped mocked origins. All ordinary local tests use isolated
// .invalid endpoints and never opt into live application configuration.
const legacyShape = process.env.TA_MOCK_FIXTURE_TARGET === 'live' || process.env.TA_UI_REVIEW === 'before' || process.env.TA_SECONDARY_PHASE === 'before'
export const MOCK_TARGET_AUTH_KEY = legacyShape ? 'sb-yyrzwpoxlxpafdlbkdtg-auth-token' : 'todayaction-mock-auth-v1'
export const MOCK_TARGET_BACKEND = legacyShape ? 'https://pjsdas-remote-alpha.vercel.app' : 'https://todayaction-backend.invalid'
export const MOCK_TARGET_AUTH_ORIGIN = legacyShape ? 'https://yyrzwpoxlxpafdlbkdtg.supabase.co' : 'https://todayaction-auth.invalid'
