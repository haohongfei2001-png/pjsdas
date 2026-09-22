import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { backendOriginFromRequest, backendUrl } from '../gateway/backendOrigin.js'
import { routeCloudflareRequest } from '../cloudflare/worker.js'

const client = readFileSync(new URL('../src/backendEndpoints.ts', import.meta.url), 'utf8')
const cloudClient = readFileSync(new URL('../src/cloud/cloudClient.ts', import.meta.url), 'utf8')
const aiAccess = readFileSync(new URL('../src/aiAccess/AiAccessContext.tsx', import.meta.url), 'utf8')
const proposalReview = readFileSync(new URL('../src/aiAccess/McpProposalReview.tsx', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../.github/workflows/deploy-pages.yml', import.meta.url), 'utf8')
const selfTest = readFileSync(new URL('../.github/workflows/production-self-test.yml', import.meta.url), 'utf8')
const cloudflareWorker = readFileSync(new URL('../cloudflare/worker.ts', import.meta.url), 'utf8')
const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678'

describe('deployment portability', () => {
  it('derives public backend URLs from the request origin without provider-specific code', () => {
    const request = new Request('https://standby.example/api/health')
    expect(backendOriginFromRequest(request, '')).toBe('https://standby.example')
    expect(backendUrl('/api/mcp', request, '')).toBe('https://standby.example/api/mcp')
  })

  it('serves the same health, release identity and OAuth contract through the Cloudflare adapter', async () => {
    const health = await routeCloudflareRequest(
      new Request('https://standby.example/api/health'),
      { PJSDAS_RELEASE_COMMIT_SHA: RELEASE_SHA },
    )
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      version: '1.10.0-alpha.1',
      resource: 'https://standby.example/api/mcp',
      release: { commitSha: RELEASE_SHA },
      capabilities: { releaseIdentityBinding: true },
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

  it('keeps the Cloudflare standby route surface aligned with current background automation APIs', () => {
    expect(cloudflareWorker).toContain("['/api/access', healthAuth]")
    expect(cloudflareWorker).toContain("'/api/automation-discovery'")
    expect(cloudflareWorker).toContain("'/api/automation-gmail'")
    expect(cloudflareWorker).toContain("'/api/automation-settings'")
    expect(cloudflareWorker).toContain("'/api/google-link'")
    expect(cloudflareWorker).toContain("'/api/mcp'")
    expect(cloudflareWorker).toContain("'/api/workspace'")
  })

  it('keeps provider selection outside business clients and binds release verification to the deployed commit', () => {
    expect(client).toContain('VITE_PJSDAS_BACKEND_ORIGINS')
    expect(client).toContain('/api/health')
    expect(client).toContain('VITE_PJSDAS_CONNECTED_AUTHORITY')
    expect(client).toContain('VITE_PJSDAS_CANONICAL_API_ORIGIN')
    expect(cloudClient).toContain("fetchBackend('/api/google-link'")
    expect(cloudClient).toContain("fetchBackend('/api/google-access-token'")
    expect(aiAccess).toContain("fetchBackend('/api/google-link'")
    expect(proposalReview).toContain("fetchBackend('/api/proposal-verify'")
    expect(cloudClient).not.toContain('vercel.app')
    expect(aiAccess).not.toContain('vercel.app')
    expect(proposalReview).not.toContain('vercel.app')
    expect(pages).toContain('PJSDAS_BACKEND_ORIGINS')
    expect(pages).toContain('PJSDAS_EXPECTED_WORKSPACE_AUTHORITY')
    expect(pages).toContain('VITE_PJSDAS_CONNECTED_AUTHORITY')
    expect(pages).toContain('PJSDAS_EXPECTED_AUDIENCE_MODE')
    expect(pages).toContain('PJSDAS_EXPECTED_CANONICAL_WEB_ORIGIN')
    expect(pages).toContain('PJSDAS_EXPECTED_CANONICAL_API_ORIGIN')
    expect(pages).toContain('health.version === "1.10.0-alpha.1"')
    expect(pages).toContain('authenticatedMcp.toolSurfaceVersion === "v7"')
    expect(pages).toContain('"list_reminder_intents"')
    expect(pages).toContain('"get_external_capabilities"')
    expect(pages).toContain('"ingest_paia_input"')
    expect(pages).toContain('capabilities.paiaOwnerIntake === "v1"')
    expect(pages).toContain('capabilities.reminderIntent === "v1"')
    expect(pages).toContain('capabilities.externalReminderCapabilityTruth === "v1"')
    expect(pages).toContain('capabilities.crossSourceSemanticDedupe === "v1"')
    expect(pages).toContain('health.release?.commitSha === process.env.GITHUB_SHA')
    expect(selfTest).toContain('PJSDAS_PRODUCTION_BASE_URLS')
    expect(selfTest).toContain('PJSDAS_EXPECTED_COMMIT_SHA')
    expect(selfTest).toContain('PJSDAS_EXPECTED_WORKSPACE_AUTHORITY')
    expect(selfTest).toContain('PJSDAS_EXPECTED_AUDIENCE_MODE')
    expect(selfTest).toContain('PJSDAS_EXPECTED_CANONICAL_WEB_ORIGIN')
    expect(selfTest).toContain('PJSDAS_EXPECTED_CANONICAL_API_ORIGIN')
    expect(selfTest).toContain('github.event.workflow_run.head_sha || github.sha')
    expect(vercel).toContain('"main": true')
    expect(vercel).toContain('"/api/access"')
    expect(vercel).toContain('"/api/health-auth?mode=access"')
    expect(wrangler).toContain('pjsdas-remote-standby')
    expect(wrangler).toContain('cloudflare/worker.ts')
  })
})
