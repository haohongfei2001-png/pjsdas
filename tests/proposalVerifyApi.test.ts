import { afterEach, describe, expect, it, vi } from 'vitest'
import proposalVerify from '../api/proposal-verify.js'
import { createSignedProposalToken } from '../gateway/proposalToken.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const SECRET = 'test-pjsdas-proposal-verify-secret'
const ORIGIN = 'https://haohongfei2001-png.github.io'
const NOW = new Date()

const changeSet: ChangeSetRecord = {
  id: 'CS-MCP-VERIFY-0001',
  version: 1,
  source: 'mcp',
  status: 'pending',
  title: '验证提议',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  operations: [{
    id: 'action:verify:done',
    kind: 'set_action_status',
    summary: '完成｜验证任务',
    actionId: 'verify-action',
    expectedStatus: 'todo',
    status: 'done',
  }],
}

afterEach(() => vi.unstubAllEnvs())

function request(token: string, origin = ORIGIN) {
  return new Request('https://pjsdas-remote-alpha.vercel.app/api/proposal-verify', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ token }),
  })
}

describe('proposal verification API', () => {
  it('returns a verified proposal for a valid signed token', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', SECRET)
    const token = await createSignedProposalToken(changeSet, 'drive:6', SECRET, NOW)
    const response = await proposalVerify.fetch(request(token))
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    await expect(response.json()).resolves.toMatchObject({
      status: 'verified',
      proposal: {
        workspaceVersion: 'drive:6',
        changeSet: { id: changeSet.id, status: 'pending', source: 'mcp' },
      },
    })
  })

  it('rejects a tampered proposal token', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', SECRET)
    const token = await createSignedProposalToken(changeSet, 'drive:6', SECRET, NOW)
    const separator = token.lastIndexOf('.')
    const tampered = `${token.slice(0, separator)}.${token.slice(separator + 1).replace(/^./, (char) => char === 'A' ? 'B' : 'A')}`
    const response = await proposalVerify.fetch(request(tampered))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: 'PROPOSAL_INVALID' })
  })

  it('rejects a browser origin outside the allow list before verifying the token', async () => {
    vi.stubEnv('PJSDAS_TOKEN_ENCRYPTION_KEY', SECRET)
    const response = await proposalVerify.fetch(request('irrelevant', 'https://evil.example'))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('allows CORS preflight from the PJSDAS GitHub Pages origin', async () => {
    const response = await proposalVerify.fetch(new Request('https://pjsdas-remote-alpha.vercel.app/api/proposal-verify', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })
})
