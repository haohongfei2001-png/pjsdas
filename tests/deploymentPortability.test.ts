import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { backendOriginFromRequest, backendUrl } from '../gateway/backendOrigin.js'
import { routeCloudflareRequest } from '../cloudflare/worker.js'

const client = readFileSync(new URL('../src/backendEndpoints.ts', import.meta.url), 'utf8')
const cloudClient = readFileSync(new URL('../src/cloud/cloudClient.ts', import.meta.url), 'utf8')
const aiAccess = readFileSync(new URL('../src/aiAccess/AiAccessContext.tsx', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const selfTest = readFileSync(new URL('../.github/workflows/production-self-test.yml', import.meta.url), 'utf8')
const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')

describe('deployment portability', () => {
  it('derives public backend URLs from the request origin without provider-specific code', () => {
    const request = new Request('https://standby.example/api/health')
    expect(backendOriginFromRequest(request, '')).toBe('https://standby.example')
    expect(backendUrl('/api/mcp', request, '')).toBe('https://standby.example/api/mcp')
  })

  it('serves the same health and OAuth contract through the Cloudflare adapter', async () => {
    const health = await routeCloudflareRequest(new Request('https://standby.example/api/health'))
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      version: '1.9.0-alpha.1',
      resource: 'https://standby.example/api/mcp',
    })

    const metadata = await routeCloudflareRequest(new Request('https://standby.example/.well-known/oauth-protected-resource'))
    expect(metadata.status).toBe(200)
    await expect(metadata.json()).resolves.toMatchObject({ resource: 'https://standby.example/api/mcp' })

    const anonymousMcp = await routeCloudflareRequest(new Request('https://standby.example/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }))
    expect(anonymousMcp.status).toBe(401)
    expect(anonymousMcp.headers.get('www-authenticate')).toContain('https://standby.example/.well-known/oauth-protected-resource')
  })

  it('keeps provider selection outside business clients and release policy', () => {
    expect(client).toContain('VITE_PJSDAS_BACKEND_ORIGINS')
    expect(client).toContain('/api/health')
    expect(cloudClient).toContain("fetchBackend('/api/google-link'")
    expect(cloudClient).toContain("fetchBackend('/api/google-access-token'")
    expect(aiAccess).toContain("fetchBackend('/api/google-link'")
    expect(cloudClient).not.toContain('vercel.app')
    expect(aiAccess).not.toContain('vercel.app')
    expect(pages).toContain('PJSDAS_BACKEND_ORIGINS')
    expect(selfTest).toContain('PJSDAS_PRODUCTION_BASE_URLS')
    expect(vercel).toContain('"main": true')
    expect(wrangler).toContain('pjsdas-remote-standby')
    expect(wrangler).toContain('cloudflare/worker.ts')
  })
})
