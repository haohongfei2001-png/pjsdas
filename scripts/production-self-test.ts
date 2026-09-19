import { DEFAULT_BACKEND_ORIGIN } from '../gateway/backendOrigin.js'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'
import { resolveProductionSelfTestAccessToken } from '../gateway/productionSelfTestAuth.js'
import { resolveProductionBaseUrls } from '../gateway/productionBaseUrls.js'

const canonicalApiOrigin = process.env.PJSDAS_EXPECTED_CANONICAL_API_ORIGIN?.trim().replace(/\/$/, '') || undefined
const configuredOrigins = process.env.PJSDAS_PRODUCTION_BASE_URLS ?? process.env.PJSDAS_PRODUCTION_BASE_URL ?? DEFAULT_BACKEND_ORIGIN
const rawOrigins = resolveProductionBaseUrls({
  canonicalApiOrigin,
  configuredOrigins,
})
const accessToken = await resolveProductionSelfTestAccessToken({
  accessToken: process.env.PJSDAS_SELF_TEST_ACCESS_TOKEN,
  email: process.env.PJSDAS_SELF_TEST_EMAIL,
  password: process.env.PJSDAS_SELF_TEST_PASSWORD,
})
const expectedCommitSha = process.env.PJSDAS_EXPECTED_COMMIT_SHA?.trim() || undefined
const requireAuthenticatedTools = process.env.PJSDAS_REQUIRE_AUTHENTICATED_SELF_TEST?.trim().toLowerCase() === 'true'
const expectedAudienceMode = process.env.PJSDAS_EXPECTED_AUDIENCE_MODE?.trim() === 'allowlist' ? 'allowlist' as const : 'legacy' as const
const expectedCanonicalWebOrigin = process.env.PJSDAS_EXPECTED_CANONICAL_WEB_ORIGIN?.trim() || undefined
const expectedCanonicalApiOrigin = canonicalApiOrigin
const expectedWorkspaceAuthority = (
  process.env.PJSDAS_EXPECTED_WORKSPACE_AUTHORITY
  ?? process.env.PJSDAS_CONNECTED_AUTHORITY
  ?? 'google-drive'
).trim() === 'transactional' ? 'transactional' as const : 'google-drive' as const

const results = []
for (const baseUrl of rawOrigins) {
  const result = await runProductionSelfTest({
    baseUrl,
    accessToken,
    expectedCommitSha,
    expectedWorkspaceAuthority,
    expectedAudienceMode,
    expectedCanonicalWebOrigin,
    expectedCanonicalApiOrigin,
    requireAuthenticatedTools,
  })
  results.push(result)
  console.log(JSON.stringify(result, null, 2))
  if (result.ok) break
}

if (!results.some((result) => result.ok)) process.exitCode = 1
