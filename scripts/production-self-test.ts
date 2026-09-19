import { DEFAULT_BACKEND_ORIGIN } from '../gateway/backendOrigin.js'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'
import { resolveProductionSelfTestAccessToken } from '../gateway/productionSelfTestAuth.js'

const rawOrigins = (process.env.PJSDAS_PRODUCTION_BASE_URLS ?? process.env.PJSDAS_PRODUCTION_BASE_URL ?? DEFAULT_BACKEND_ORIGIN)
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
const accessToken = await resolveProductionSelfTestAccessToken({
  accessToken: process.env.PJSDAS_SELF_TEST_ACCESS_TOKEN,
  email: process.env.PJSDAS_SELF_TEST_EMAIL,
  password: process.env.PJSDAS_SELF_TEST_PASSWORD,
})
const expectedCommitSha = process.env.PJSDAS_EXPECTED_COMMIT_SHA?.trim() || undefined
const requireAuthenticatedTools = process.env.PJSDAS_REQUIRE_AUTHENTICATED_SELF_TEST?.trim().toLowerCase() === 'true'
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
    requireAuthenticatedTools,
  })
  results.push(result)
  console.log(JSON.stringify(result, null, 2))
  if (result.ok) break
}

if (!results.some((result) => result.ok)) process.exitCode = 1
