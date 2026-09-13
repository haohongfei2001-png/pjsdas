import { DEFAULT_BACKEND_ORIGIN } from '../gateway/backendOrigin.js'
import { runProductionSelfTest } from '../gateway/productionSelfTest.js'

const rawOrigins = (process.env.PJSDAS_PRODUCTION_BASE_URLS ?? process.env.PJSDAS_PRODUCTION_BASE_URL ?? DEFAULT_BACKEND_ORIGIN)
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
const accessToken = process.env.PJSDAS_SELF_TEST_ACCESS_TOKEN?.trim() || undefined

const results = []
for (const baseUrl of rawOrigins) {
  const result = await runProductionSelfTest({ baseUrl, accessToken })
  results.push(result)
  console.log(JSON.stringify(result, null, 2))
  if (result.ok) break
}

if (!results.some((result) => result.ok)) process.exitCode = 1
