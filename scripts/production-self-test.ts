import { runProductionSelfTest } from '../gateway/productionSelfTest.js'

const baseUrl = (process.env.PJSDAS_PRODUCTION_BASE_URL ?? 'https://pjsdas-remote-alpha.vercel.app').replace(/\/$/, '')
const accessToken = process.env.PJSDAS_SELF_TEST_ACCESS_TOKEN?.trim() || undefined

const result = await runProductionSelfTest({ baseUrl, accessToken })
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
