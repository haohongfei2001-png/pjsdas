import { describe, expect, it, vi } from 'vitest'
import { createDriveWorkspaceSource } from '../gateway/driveWorkspaceSource.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'
import { createSnapshot } from '../src/snapshot.js'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function snapshot() {
  return createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  }, '2026-09-13T00:00:00.000Z')
}

async function typedError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (caught) {
    expect(caught).toBeInstanceOf(WorkspaceSourceError)
    return caught as WorkspaceSourceError
  }
  throw new Error('Expected WorkspaceSourceError')
}

describe('autonomous Drive workspace writes', () => {
  it('fails closed before upload when the exact read baseline is stale', async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.includes('/files?')) return json({ files: [{ id: 'drive-file-1', version: '17', modifiedTime: '2026-09-13T00:01:00.000Z' }] })
      throw new Error(`unexpected request ${url}`)
    }) as unknown as typeof fetch
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'token', fetchImpl })

    const error = await typedError(source.write!({
      snapshot: snapshot(),
      expectedWorkspaceVersion: 'drive:16',
    }))

    expect(error.code).toBe('WORKSPACE_CONFLICT')
    expect(error.retryable).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('checks the baseline again and only then PATCHes the verified envelope', async () => {
    const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      if (url.includes('/upload/drive/v3/files/drive-file-1')) {
        expect(init?.method).toBe('PATCH')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token')
        const body = JSON.parse(String(init?.body)) as { schema?: string; fingerprint?: string; updatedByDevice?: string }
        expect(body.schema).toBe('pjsdas-google-drive-workspace')
        expect(body.fingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(body.updatedByDevice).toBe('monitor-test')
        return json({ id: 'drive-file-1', version: '18', modifiedTime: '2026-09-13T00:02:00.000Z' })
      }
      if (url.includes('/files?')) return json({ files: [{ id: 'drive-file-1', version: '17', modifiedTime: '2026-09-13T00:01:00.000Z' }] })
      if (url.includes('/files/drive-file-1?')) return json({ id: 'drive-file-1', version: '17', modifiedTime: '2026-09-13T00:01:00.000Z' })
      throw new Error(`unexpected request ${url}`)
    }) as unknown as typeof fetch
    const source = createDriveWorkspaceSource({
      getAccessToken: () => 'token',
      fetchImpl,
      now: () => new Date('2026-09-13T00:03:00.000Z'),
    })

    const written = await source.write!({
      snapshot: snapshot(),
      expectedWorkspaceVersion: 'drive:17',
      updatedByDevice: 'monitor-test',
    })

    expect(written.context.workspaceVersion).toBe('drive:18')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
