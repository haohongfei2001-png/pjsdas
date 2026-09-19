import { describe, expect, it, vi } from 'vitest'
import { invokeTrustedIngestion } from '../gateway/ingestSources.js'
import { WorkspaceSourceError, type WorkspaceSource } from '../gateway/workspaceSource.js'

describe('trusted ingestion authorization order', () => {
  it('rejects an ungranted source before reading any workspace data', async () => {
    const read = vi.fn(async () => { throw new Error('workspace must not be touched') })
    const source: WorkspaceSource = { read }
    const result = await invokeTrustedIngestion(source, 'ingest_discovery_run', {
      runId: 'run-1',
      sourceId: 'monitor:not-granted',
      startedAt: '2026-09-19T00:00:00.000Z',
      completedAt: '2026-09-19T00:01:00.000Z',
      observations: [],
    }, {
      authorize: async () => {
        throw new WorkspaceSourceError('AUTH_FORBIDDEN', 'Source not granted.', false)
      },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(result.content)).toContain('AUTH_FORBIDDEN')
    expect(read).not.toHaveBeenCalled()
  })
})
