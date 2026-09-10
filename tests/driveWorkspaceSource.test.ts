import { describe, expect, it, vi } from 'vitest'
import { createDriveWorkspaceEnvelope } from '../src/cloud/driveEnvelope'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint'
import { createSnapshot } from '../src/snapshot'
import { createDriveWorkspaceSource } from '../gateway/driveWorkspaceSource'
import { invokeReadTool } from '../gateway/readTools'
import { WorkspaceSourceError } from '../gateway/workspaceSource'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptySnapshot() {
  return createSnapshot({
    opportunities: [],
    processes: [],
    processEvents: [],
    actions: [],
    prep: [],
    applicationGroups: [],
  }, '2026-09-11T00:00:00.000Z')
}

async function validEnvelope() {
  const snapshot = emptySnapshot()
  return createDriveWorkspaceEnvelope({
    fingerprint: await fingerprintWorkspace(snapshot),
    deviceId: 'device-test',
    snapshot,
    updatedAt: '2026-09-11T01:00:00.000Z',
  })
}

function driveMock(input: {
  envelope: unknown
  files?: Array<{ id?: string; version?: string | number; modifiedTime?: string }>
  listStatus?: number
  mediaStatus?: number
}) {
  const fetchImpl = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request)
    if (url.includes('alt=media')) return json(input.envelope, input.mediaStatus ?? 200)
    if (url.includes('/files?')) {
      return json({
        files: input.files ?? [{ id: 'drive-file-1', version: '17', modifiedTime: '2026-09-11T01:02:03.000Z' }],
      }, input.listStatus ?? 200)
    }
    if (url.includes('/files/drive-file-1?')) {
      return json({ id: 'drive-file-1', version: '17', modifiedTime: '2026-09-11T01:02:03.000Z' })
    }
    return json({ error: 'unexpected URL' }, 500)
  }) as unknown as typeof fetch

  return fetchImpl
}

async function sourceError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (caught) {
    expect(caught).toBeInstanceOf(WorkspaceSourceError)
    return caught as WorkspaceSourceError
  }
  throw new Error('Expected WorkspaceSourceError')
}

describe('Google Drive MCP workspace source', () => {
  it('reads only appDataFolder, verifies the envelope, and returns stable bridge context', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({ envelope })
    const source = createDriveWorkspaceSource({
      getAccessToken: () => 'test-access-token',
      fetchImpl,
      timezone: 'Asia/Shanghai',
      now: () => new Date('2026-09-11T02:00:00.000Z'),
      defaultAvailableMinutes: 240,
    })

    const workspace = await source.read()

    expect(workspace.snapshot).toEqual(envelope.snapshot)
    expect(workspace.context).toEqual({
      now: new Date('2026-09-11T02:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      workspaceVersion: 'drive:17',
      defaultAvailableMinutes: 240,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(fetchImpl).mock.calls
    const listUrl = String(calls[0]![0])
    expect(listUrl).toContain('spaces=appDataFolder')
    expect(decodeURIComponent(listUrl)).toContain("name = 'pjsdas-workspace.json' and trashed = false")
    expect(String(calls[1]![0])).toContain('/files/drive-file-1?alt=media')

    for (const [, init] of calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-token')
    }
  })

  it('fails closed when more than one PJSDAS workspace exists', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({
      envelope,
      files: [
        { id: 'drive-file-1', version: '17', modifiedTime: '2026-09-11T01:02:03.000Z' },
        { id: 'drive-file-2', version: '18', modifiedTime: '2026-09-11T01:03:03.000Z' },
      ],
    })
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'token', fetchImpl })

    const error = await sourceError(source.read())
    expect(error.code).toBe('WORKSPACE_DUPLICATE')
    expect(error.retryable).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not expose a workspace whose fingerprint does not match its snapshot', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({ envelope: { ...envelope, fingerprint: 'tampered' } })
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'token', fetchImpl })

    const error = await sourceError(source.read())
    expect(error.code).toBe('WORKSPACE_INVALID')
    expect(error.message).toMatch(/fingerprint/i)
  })

  it('maps expired Google authorization to a stable non-retryable source error', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({ envelope, listStatus: 401 })
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'expired-token', fetchImpl })

    const error = await sourceError(source.read())
    expect(error.code).toBe('GOOGLE_AUTH_EXPIRED')
    expect(error.retryable).toBe(false)
    expect(error.message).not.toContain('expired-token')
  })

  it('marks Drive throttling as retryable without leaking credentials', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({ envelope, listStatus: 429 })
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'private-token', fetchImpl })

    const error = await sourceError(source.read())
    expect(error.code).toBe('GOOGLE_DRIVE_UNAVAILABLE')
    expect(error.retryable).toBe(true)
    expect(error.message).not.toContain('private-token')
  })

  it('surfaces typed Drive source failures through MCP instead of collapsing them to a generic error', async () => {
    const envelope = await validEnvelope()
    const fetchImpl = driveMock({ envelope, files: [] })
    const source = createDriveWorkspaceSource({ getAccessToken: () => 'token', fetchImpl })

    const result = await invokeReadTool(source, 'get_decision_rules', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    if (result.content[0]?.type === 'text') {
      expect(result.content[0].text).toContain('WORKSPACE_NOT_FOUND')
      expect(result.content[0].text).not.toContain('token')
    }
  })
})
