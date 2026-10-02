import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('denies normal/forced paid workers and preserves account-bound readiness under failure', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/discoveryBudgetBoundary.mjs', import.meta.url)), process.cwd()], { encoding: 'utf8', timeout: 15000 })
  expect(output).toContain('PASS configured normal and forced workers deny without an adapter; zero generator calls.')
  expect(output).toContain('PASS stalled profile projection aborts to unknown')
  expect(output).toContain('PASS projection failure preserves Gmail status')
}, 20000)
