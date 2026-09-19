import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const rcBrowser = readFileSync(new URL('../.github/workflows/rc-browser-hardening.yml', import.meta.url), 'utf8')

describe('required status-check names', () => {
  it('keeps CI and Pages build job ids unique for branch protection', () => {
    expect(ci).toContain('\n  ci-build:\n')
    expect(pages).toContain('\n  pages-build:\n')
    expect(pages).toContain('needs: pages-build')
    expect(ci).not.toContain('\n  build:\n')
    expect(pages).not.toContain('\n  build:\n')
  })

  it('keeps the expensive RC browser matrix out of ordinary pull requests', () => {
    expect(rcBrowser).toContain('workflow_dispatch:')
    expect(rcBrowser).not.toContain('pull_request:')
  })
})
