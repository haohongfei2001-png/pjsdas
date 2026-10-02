import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
const sameRepository = 'github.event.pull_request.head.repo.full_name == github.repository'
const exactHeadLabel = "format('full:{0}', github.event.pull_request.head.sha)"

describe('bounded exact-head draft validation', () => {
  it.each(['browser-e2e.yml', 'tsui05-browser-matrix.yml', 'ci.yml', 'cgr02-voiceover.yml'])('%s ignores unrelated labels and preserves read-only bounds', file => {
    const workflow = read(file)
    const eventTypes = workflow.match(/types: \[([^\]]+)\]/)?.[1]
    expect(eventTypes).toBeDefined()
    expect(eventTypes).not.toMatch(/\b(?:labeled|unlabeled)\b/)
    expect(workflow).not.toContain('github.event.label.name')
    expect(workflow).toContain('permissions:\n  contents: read')
    const bounds = [...workflow.matchAll(/timeout-minutes: (\d+)/g)].map(match => Number(match[1]))
    expect(bounds.length).toBeGreaterThan(0)
    // Matrix includes 204 core + 134 dense cases and a strict performance tail.
    // Its approved orchestration allowance does not change any test budget.
    const maximum = file === 'tsui05-browser-matrix.yml' ? 35 : 30
    expect(bounds.every(minutes => minutes > 0 && minutes <= maximum)).toBe(true)
  })
  it.each(['browser-e2e.yml', 'tsui05-browser-matrix.yml', 'ci.yml'])('%s only opts a draft in for its own exact source SHA', file => {
    const workflow = read(file)
    expect(workflow).toContain("github.event_name != 'pull_request' || github.event.pull_request.draft == false")
    expect(workflow).toContain(`${sameRepository} && contains(github.event.pull_request.labels.*.name, ${exactHeadLabel})`)
    expect(workflow).not.toContain("contains(github.event.pull_request.labels.*.name, 'full-validation')")
  })
  it('avoids duplicate focused runs only for an exact full-validation opt-in', () => {
    const workflow = read('instant-recovery-draft.yml')
    expect(workflow).toContain(`github.event.pull_request.draft == true && !(${sameRepository} && contains(github.event.pull_request.labels.*.name, ${exactHeadLabel}))`)
    expect(workflow).toContain('timeout-minutes: 12')
  })
  it('does not conditionally skip the required unit/type job for metadata events', () => {
    const requiredJob = read('ci.yml').match(/  ci-build:([\s\S]*?)    runs-on:/)?.[1]
    expect(requiredJob).toBeDefined()
    expect(requiredJob).not.toContain('if:')
  })

})
