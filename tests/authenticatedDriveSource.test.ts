import { describe, expect, it, vi } from 'vitest'
import { createSnapshot } from '../src/snapshot'
import { createDriveWorkspaceEnvelope } from '../src/cloud/driveEnvelope'
import { fingerprintWorkspace } from '../src/cloud/workspaceFingerprint'
import { createAuthenticatedDriveWorkspaceSource } from '../gateway/authenticatedDriveSource'
import { encryptSecret } from '../gateway/tokenCrypto'

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

const KEY = Buffer.alloc(32, 7).toString('base64url')

async function fixture() {
  const snapshot = createSnapshot({
    opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [],
  }, '2026-09-11T00:00:00.000Z')
  const envelope = createDriveWorkspaceEnvelope({
    fingerprint: await fingerprintWorkspace(snapshot),
    deviceId: 'device-test',
    snapshot,
    updatedAt: '2026-09-11T01:00:00.000Z',
  })
  return { snapshot, envelope }
}

describe('authenticated Google Drive workspace source', () => {
  it('binds the MCP bearer identity to that user\'s encrypted Google connection before reading Drive', async () => {
    const { envelope } = await fixture()
    const encryptedRefreshToken = await encryptSecret('google-refresh-secret', KEY)
    const calls: Array<{ url: string; auth: string | null; body?: string }> = []

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('authorization')
      calls.push({ url, auth, body: typeof init?.body === 'string' ? init.body : undefined })

      if (url.endsWith('/auth/v1/user')) return json({ id: 'user-a', email: 'a@example.com' })
      if (url.includes('/rest/v1/google_drive_connections?')) {
        return json([{
          user_id: 'user-a', google_subject: 'google-a', google_email: 'a@gmail.com',
          refresh_token_ciphertext: encryptedRefreshToken,
          granted_scopes: ['https://www.googleapis.com/auth/drive.appdata'], revoked_at: null,
        }])
      }
      if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'google-access-token' })
      if (url.includes('www.googleapis.com/drive/v3/files?')) {
        return json({ files: [{ id: 'drive-file-1', version: '21', modifiedTime: '2026-09-11T01:02:03.000Z' }] })
      }
      if (url.includes('/files/drive-file-1?alt=media')) return json(envelope)
      return json({ error: 'unexpected' }, 500)
    }) as unknown as typeof fetch

    const request = new Request('https://pjsdas.example/api/mcp', {
      headers: { Authorization: 'Bearer pjsdas-user-token' },
    })
    const source = await createAuthenticatedDriveWorkspaceSource(request, {
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client',
      googleClientSecret: 'google-secret',
      fetchImpl,
      timezone: 'Asia/Shanghai',
    })
    const result = await source.read()

    expect(result.context.workspaceVersion).toBe('drive:21')
    expect(calls[0]).toMatchObject({ auth: 'Bearer pjsdas-user-token' })
    expect(calls[1]?.url).toContain('user_id=eq.user-a')
    expect(calls[1]).toMatchObject({ auth: 'Bearer pjsdas-user-token' })
    expect(calls[2]?.body).toContain('refresh_token=google-refresh-secret')
    expect(calls[3]).toMatchObject({ auth: 'Bearer google-access-token' })
    expect(calls.map((call) => `${call.auth ?? ''}${call.body ?? ''}`).join('\n')).not.toContain(encryptedRefreshToken)
  })

  it('rejects a request without a PJSDAS bearer token before touching Supabase data', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(createAuthenticatedDriveWorkspaceSource(new Request('https://pjsdas.example/api/mcp'), {
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-key',
      tokenEncryptionKey: KEY,
      googleClientId: 'google-client',
      googleClientSecret: 'google-secret',
      fetchImpl,
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
