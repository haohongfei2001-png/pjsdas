import { describe, expect, it } from 'vitest'
import health, { PUBLIC_HEALTH_CAPABILITIES } from '../api/health.js'

describe('public production health contract', () => {
  it('describes the authenticated v1.4 primary gateway without exposing demo data or secrets', async () => {
    const response = health.fetch()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = await response.json() as Record<string, any>
    expect(body).toMatchObject({
      service: 'pjsdas-authenticated-mcp',
      version: '1.4.0-alpha.1',
      mode: 'google-drive-readonly',
      auth: 'supabase-oauth-2.1',
      resource: 'https://pjsdas-remote-alpha.vercel.app/api/mcp',
      capabilities: PUBLIC_HEALTH_CAPABILITIES,
      status: 'ok',
    })
    expect(JSON.stringify(body)).not.toContain('synthetic-demo-only')
    expect(body).not.toHaveProperty('secretsConfigured')
  })
})
