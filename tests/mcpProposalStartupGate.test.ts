import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const cloudContext = readFileSync(new URL('../src/cloud/CloudContext.tsx', import.meta.url), 'utf8')

describe('MCP proposal startup gate', () => {
  it('does not mount proposal review until CloudProvider has restored its initial account state', () => {
    expect(entry).toContain("import { CloudProvider, useCloud } from './cloud/CloudContext.js'")
    expect(entry).toContain('function CloudReadyMcpProposalReview()')
    expect(entry).toContain('if (cloud.loading) return null')
    expect(entry).toContain('<CloudReadyMcpProposalReview />')
    expect(entry).not.toContain('<McpProposalReview />\n        <Root />')
  })

  it('keeps CloudProvider loading true until initial session restoration settles', () => {
    expect(cloudContext).toContain('const [loading, setLoading] = useState(true)')
    expect(cloudContext).toContain(".finally(() => {\n        if (active) setLoading(false)\n      })")
  })
})
