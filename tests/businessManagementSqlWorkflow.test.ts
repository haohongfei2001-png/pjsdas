import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const workflow=readFileSync(new URL('../.github/workflows/consumer-management-sql.yml',import.meta.url),'utf8')
const runner=readFileSync(new URL('./sql/management-grants-concurrency.mjs',import.meta.url),'utf8')
describe('isolated management SQL gate',()=>{
 it('runs bounded fixtures with read-only repository permissions and no deployment credentials',()=>{
  expect(workflow).toContain('permissions:\n  contents: read')
  expect(workflow).toContain('timeout-minutes: 10')
  expect(workflow).toContain('npm ci --prefix tests/sql --ignore-scripts')
  expect(workflow).toContain('npm run test:concurrency --prefix tests/sql')
  expect(workflow).not.toMatch(/secrets\.|SUPABASE_|supabase (db push|link)|id-token: write/)
 })
 it('rejects non-fixture database targets and coordinates actual lock waits',()=>{
  expect(runner).toContain("['127.0.0.1','localhost'].includes(url.hostname)")
  expect(runner).toContain("url.pathname !== '/ta_management_fixture'")
  expect(runner).toContain("url.password !== 'fixture-only'")
  expect(runner).toContain('pg_stat_activity')
  expect(runner).toContain("waitForLock('revoker'")
  expect(runner).toContain("error?.code,'42501'")
 })
})
