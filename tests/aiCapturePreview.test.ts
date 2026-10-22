import { describe, expect, it, vi } from 'vitest'
import { createAiCapturePreviewHandler } from '../gateway/aiCapturePreviewHandler.js'
import { buildAiCaptureModelRequest, createAiCaptureGatewayTransport } from '../gateway/aiCapturePreview.js'
import { WorkspaceSourceError } from '../gateway/workspaceSource.js'

const ORIGIN = 'https://app.example.test'
const text = '明天给植物浇水'
const input = { text, timezone: 'Asia/Shanghai', requestId: 'capture:synthetic', expectedRevision: 4 }
const result = (mode = 'current_intent') => ({ statementMode: mode, interpretation: { contractVersion: 1,
  candidates: [{ kind: 'manual_action', title: '给植物浇水', plannedDate: '2026-10-20', evidence: { start: 0, end: text.length, quote: text }, confidence: 'high' }], clarifications: [] } })
function fixture(enabled = true) {
  const workspace = { userId: 'synthetic-user', workspaceId: 'workspace', revision: 4, schemaVersion: 1,
    snapshot: { data: { opportunities: [{ id: 'secret-job-id', company: 'Private company', role: 'Private role', notes: 'NEVER SEND THIS' }] } } } as any
  const fetchImpl = vi.fn(async () => Response.json({ id: 'synthetic-user' }))
  const readWorkspace = vi.fn(async () => workspace)
  const authorizeIdentity = vi.fn(async () => ({ allowed: true }))
  let row: any = null
  const ledger = {
    read: vi.fn(async () => row),
    admit: vi.fn(async (value: any) => {
      if (row) throw new Error('duplicate dispatch')
      row = { user_id: value.userId, request_id: value.requestId, payload_hash: value.payloadHash, text: value.text,
        timezone: value.timezone, reference_time: value.referenceTime, expected_revision: value.expectedRevision, expires_at: '2026-10-19T00:15:00.000Z', status: 'DISPATCHED', review: null, observation: null }
    }),
    finish: vi.fn(async (value: any) => { if (!row || row.status !== 'DISPATCHED') throw new Error('immutable'); Object.assign(row, { status: value.status, review: value.review, observation: value.observation }) }),
  }
  const beforeDispatch = vi.fn(async () => undefined)
  const transport = vi.fn(async (_request: unknown, before: () => Promise<void>) => { await before(); return JSON.stringify(result()) })
  const handler = createAiCapturePreviewHandler({ supabaseUrl: 'https://auth.example.test', supabasePublishableKey: 'public-test-key', allowedOrigins: [ORIGIN], fetchImpl,
    readWorkspace, authorizeIdentity, now: () => new Date('2026-10-19T00:00:00Z'), ...(enabled ? { runtime: { beforeDispatch, transport, ledger, reservationUnits: 100 } } : {}) })
  const request = (body: unknown = input, headers: Record<string, string> = {}) => handler(new Request('https://backend.example.test/api/workspace?surface=ai-capture-preview', {
    method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer synthetic-token', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  return { request, handler, workspace, fetchImpl, readWorkspace, authorizeIdentity, beforeDispatch, transport, ledger }
}
describe('authenticated candidate-only model preview', () => {
  it('defaults off even with an authenticated user; no model, workspace read or write', async () => {
    const f = fixture(false); const response = await f.request(); expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('AI_CAPTURE_NOT_ENABLED'); expect(f.transport).not.toHaveBeenCalled(); expect(f.readWorkspace).not.toHaveBeenCalled()
  })
  it('performs actual interpretation via the injected model and persists an exact review before enabling confirmation', async () => {
    const f = fixture(); const response = await f.request(); expect(response.status).toBe(200)
    const body = await response.json(); expect(body).toMatchObject({ canCommit: true, workspaceRevision: 4, referenceTime: '2026-10-19T00:00:00.000Z', review: { status: 'ready_for_review', statementMode: 'current_intent' } })
    expect(f.beforeDispatch).toHaveBeenCalledOnce(); expect(f.transport).toHaveBeenCalledOnce()
    const outgoing = JSON.stringify(f.transport.mock.calls[0][0]); expect(outgoing).not.toContain('Private company'); expect(outgoing).not.toContain('secret-job-id'); expect(outgoing).not.toContain('synthetic-user'); expect(outgoing).not.toContain('NEVER SEND THIS')
  })
  it.each(['question', 'quote', 'example', 'hypothetical', 'rewrite_request'])('does not upgrade model %s to write intent', async mode => {
    const f = fixture(); f.transport.mockImplementation(async (_request, before) => { await before(); return JSON.stringify(result(mode)) })
    const response = await f.request(); expect((await response.json()).review).toMatchObject({ status: 'no_write', statementMode: mode })
  })
  it('locally vetoes write-intent output for a question', async () => {
    const f = fixture(); const response = await f.request({ ...input, text: '明天要浇水吗？' }); expect((await response.json()).review.status).toBe('no_write')
  })
  it('rejects too-short receipt identifiers before any model admission or dispatch', async () => {
    const f = fixture(); expect((await f.request({ ...input, requestId: 'r1' })).status).toBe(400)
    expect(f.transport).not.toHaveBeenCalled(); expect(f.beforeDispatch).not.toHaveBeenCalled()
  })
  it('rejects unknown client authority fields', async () => {
    const f = fixture(); expect((await f.request({ ...input, ownerKey: 'someone-else' })).status).toBe(400); expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects unapproved origin and missing authentication before model access', async () => {
    const f = fixture(); expect((await f.request(input, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await f.request(input, { authorization: '' })).status).toBe(401); expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects audience denial and cross-account workspace', async () => {
    const f = fixture(); f.authorizeIdentity.mockResolvedValue({ allowed: false }); expect((await f.request()).status).toBe(403)
    f.authorizeIdentity.mockResolvedValue({ allowed: true }); f.workspace.userId = 'other'; expect((await f.request()).status).toBe(403); expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects stale input before model dispatch', async () => {
    const f = fixture(); expect((await f.request({ ...input, expectedRevision: 3 })).status).toBe(409); expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects revocation at the final boundary', async () => {
    const f = fixture(); f.authorizeIdentity.mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false })
    expect((await f.request()).status).toBe(401); expect(f.beforeDispatch).not.toHaveBeenCalled()
  })
  it('rejects a workspace changed while interpretation ran', async () => {
    const f = fixture(); f.readWorkspace.mockResolvedValueOnce(f.workspace).mockResolvedValueOnce(f.workspace).mockResolvedValue({ ...f.workspace, revision: 5 })
    expect((await f.request()).status).toBe(409)
  })
  it('retains honest model failures without leaking upstream messages or silently parsing locally', async () => {
    const f = fixture(); f.transport.mockRejectedValue(new Error('secret provider body'))
    const response = await f.request(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret provider body'); expect(f.transport).toHaveBeenCalledOnce()
  })
  it('rejects malformed output, unsupported authority and oversize stream', async () => {
    const f = fixture(); f.transport.mockResolvedValue('{bad'); expect((await f.request()).status).toBe(503)
    expect((await f.request({ ...input, text: 'x'.repeat(40_001) })).status).toBe(413)
  })
  it('recovers a persisted preview without another dispatch, preserving server time', async () => {
    const f = fixture(); const first = await (await f.request()).json(); const second = await (await f.request()).json()
    expect(second).toEqual(first); expect(f.transport).toHaveBeenCalledOnce(); expect(f.ledger.admit).toHaveBeenCalledOnce()
    expect((await f.request({ ...input, text: 'changed' })).status).toBe(409)
    expect(f.transport).toHaveBeenCalledOnce()
  })
  it('reports known expired/stale persisted previews explicitly without dispatching again', async () => {
    const expired = fixture(); await expired.request()
    const stored = await expired.ledger.read(); stored.expires_at = '2000-01-01T00:00:00Z'
    const response = await expired.request(); expect(response.status).toBe(409); expect((await response.json()).code).toBe('AI_CAPTURE_EXPIRED')
    expect(expired.transport).toHaveBeenCalledOnce()
    const stale = fixture(); await stale.request(); stale.workspace.revision = 5
    const changed = await stale.request(); expect(changed.status).toBe(409); expect((await changed.json()).code).toBe('AI_CAPTURE_STALE')
    expect(stale.transport).toHaveBeenCalledOnce()
  })
  it('durably fences unknown outcomes and never resends the same request', async () => {
    const f = fixture(); f.transport.mockImplementation(async (_request, before) => { await before(); throw new Error('network unknown') })
    expect((await f.request()).status).toBe(503)
    expect((await (await f.request()).json()).code).toBe('AI_CAPTURE_RESULT_UNKNOWN')
    expect(f.transport).toHaveBeenCalledOnce(); expect(f.ledger.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'UNKNOWN' }))
  })
  it('does not return a committable review when durable finalization fails', async () => {
    const f = fixture(); f.ledger.finish.mockRejectedValue(new Error('unavailable'))
    expect((await f.request()).status).toBe(503); expect((await f.request()).status).toBe(409)
    expect(f.transport).toHaveBeenCalledOnce()
  })
  it('cannot dispatch when durable admission denies even after consent passes', async () => {
    const f = fixture(); f.ledger.admit.mockRejectedValue(new Error('disabled free-only budget'))
    expect((await f.request()).status).toBe(503); expect(f.ledger.finish).not.toHaveBeenCalled()
  })
  it('includes a strict output schema and bounded context without IDs', () => {
    const request = buildAiCaptureModelRequest(input, '2026-10-19T00:00:00Z')
    expect(JSON.parse(request.prompt)).toEqual({ text, timezone: input.timezone, referenceTime: '2026-10-19T00:00:00Z' })
    expect(request.system).toContain('Schema:'); expect(request.system).toContain('UTF-16')
  })
})

describe('real installed AI SDK with synthetic network only', () => {
  const successful = () => Response.json({ content: [{ type: 'text', text: JSON.stringify(result()) }], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }, warnings: [] })
  it('dispatches only once to the existing Gateway with existing model and provider, no tools', async () => {
    const events: string[] = []; const network = vi.fn<typeof fetch>(async () => { events.push('fetch'); return successful() })
    const call = createAiCaptureGatewayTransport({ apiKey: 'synthetic-not-real', fetchImpl: network })
    await call(buildAiCaptureModelRequest(input, '2026-10-19T00:00:00Z'), async () => { events.push('admit') })
    expect(events).toEqual(['admit', 'fetch']); expect(network).toHaveBeenCalledOnce()
    const [url, init] = network.mock.calls[0]; expect(String(url)).toBe('https://ai-gateway.vercel.sh/v4/ai/language-model'); expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('ai-language-model-id')).toBe('openai/gpt-4.1-mini')
    const body = JSON.parse(init!.body as string); expect(body.toolChoice).toEqual({ type: 'none' }); expect(body.providerOptions.gateway.only).toEqual(['openai'])
  })
  it('does not send when admission denies and preserves denial', async () => {
    const network = vi.fn<typeof fetch>(async () => successful()); const call = createAiCaptureGatewayTransport({ apiKey: 'synthetic-not-real', fetchImpl: network })
    const denied = new WorkspaceSourceError('AI_CAPTURE_BUDGET_DENIED', 'No approved funding.', false)
    await expect(call(buildAiCaptureModelRequest(input, '2026-10-19T00:00:00Z'), async () => { throw denied })).rejects.toBe(denied)
    expect(network).not.toHaveBeenCalled()
  })
  it('never retries unknown network outcomes', async () => {
    const network = vi.fn<typeof fetch>(async () => { throw new Error('synthetic disconnect') }); const call = createAiCaptureGatewayTransport({ apiKey: 'synthetic-not-real', fetchImpl: network })
    await expect(call(buildAiCaptureModelRequest(input, '2026-10-19T00:00:00Z'), async () => undefined)).rejects.toThrow(); expect(network).toHaveBeenCalledOnce()
  })
})
