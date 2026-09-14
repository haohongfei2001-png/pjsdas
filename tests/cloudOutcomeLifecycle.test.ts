import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/cloud/CloudContext.tsx', import.meta.url), 'utf8')

function section(start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`Could not locate CloudContext section: ${start}`)
  return source.slice(from, to)
}

describe('cloud operation outcome lifecycle', () => {
  it('clears the previous success outcome before a new sync attempt can fail', () => {
    const block = section('const syncNow = useCallback', 'useEffect(() => {\n    const userId = session?.user.id')
    expect(block).toContain('setOutcome(undefined)')
    expect(block.indexOf('setOutcome(undefined)')).toBeLessThan(block.indexOf('runCloudSync(userId)'))
    expect(block.indexOf('setOutcome(undefined)')).toBeLessThan(block.indexOf('setError(undefined)'))
  })

  it('clears the previous success outcome before conflict resolution or account rebind', () => {
    const block = section("const runResolution = useCallback", 'const signIn = useCallback')
    expect(block).toContain('setOutcome(undefined)')
    expect(block.indexOf('setOutcome(undefined)')).toBeLessThan(block.indexOf("kind === 'keep'"))
  })

  it('does not carry a previous sync success into a new sign-in session', () => {
    const block = section('const signIn = useCallback', 'const value = useMemo')
    expect(block).toContain('setOutcome(undefined)')
    expect(block.indexOf('setOutcome(undefined)')).toBeLessThan(block.indexOf('signInWithGoogle()'))
  })
})
