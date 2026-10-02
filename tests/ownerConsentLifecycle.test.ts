import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
describe('synthetic actual-source owner consent lifecycle contracts (not DOM/browser proof)', () => {
  it('preserves fresh consent and unresolved identity across restoration, login, storage errors and accounts', () => {
    const repo = fileURLToPath(new URL('../', import.meta.url))
    const script = fileURLToPath(
      new URL('./owner-consent-source-contract.cjs', import.meta.url),
    )
    const output = execFileSync(process.execPath, [script, repo], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(output).toContain('5/5 synthetic actual-source contracts passed.')
    expect(output).toContain('NOT_RUN: real React DOM')
  }, 25_000)
})
