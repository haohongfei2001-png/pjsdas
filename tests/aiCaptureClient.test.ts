import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), workspace: vi.fn(), token: vi.fn(), assert: vi.fn(), execute: vi.fn(), confirm: vi.fn() }))
vi.mock('../src/backendEndpoints.js', () => ({ fetchBackend: mocks.fetch }))
vi.mock('../src/cloud/connectedWorkspaceRepository.js', () => ({ fetchConnectedRemoteWorkspace: mocks.workspace }))
vi.mock('../src/cloud/cloudClient.js', () => ({ getAccountAccessToken: mocks.token }))
vi.mock('../src/cloud/accountCacheLease.js', () => ({ captureAccountCacheLease: () => ({ assertCurrent: mocks.assert }) }))
vi.mock('../src/cloud/workspaceWriteLease.js', () => ({ captureWorkspaceWriteLease: () => ({ assertCurrent: mocks.assert }) }))
vi.mock('../src/cloud/authoritativeCommandClient.js', () => ({ executeConnectedBusinessCommand: mocks.execute, confirmConnectedCommand: mocks.confirm }))
import { previewAiCapture, confirmAiCapture, isCurrentAiPreview, type AiCapturePreview } from '../src/aiCaptureClient.js'
const preview = (): AiCapturePreview => ({ mode: 'current_intent', candidates: [], unresolved: [], ignored: [], ai: {
  requestId: 'request-1', accountKey: 'user-a', text: '买咖啡', timezone: 'Asia/Shanghai', referenceTime: '2026-10-19T00:00:00Z', workspaceRevision: 4, canCommit: true } })
const response = (extra = {}) => Response.json({ requestId: 'request-1', referenceTime: '2026-10-19T00:00:00Z', workspaceRevision: 4,
  review: { status: 'ready_for_review', statementMode: 'current_intent', candidates: [], issues: [] }, canCommit: true, ...extra })
beforeEach(() => { vi.resetAllMocks(); mocks.workspace.mockResolvedValue({ version: 'txn:4', snapshot: { data: {} } }); mocks.token.mockResolvedValue('synthetic-token'); mocks.fetch.mockResolvedValue(response()); mocks.execute.mockResolvedValue({ outcome: 'COMMITTED', result: { status: 'APPLIED', summary: 'saved' }, receipt: { undoAvailable: true } }); mocks.confirm.mockResolvedValue({ outcome: 'ALREADY_APPLIED', result: { status: 'ALREADY_APPLIED' } }) })
describe('AI capture browser contract', () => {
  it('sends only the explicit input, timezone, request identity and checked workspace revision', async () => {
    const result = await previewAiCapture('买咖啡', 'user-a', 'request-1'); expect(result.ai.canCommit).toBe(true)
    const [path, init] = mocks.fetch.mock.calls[0]; expect(path).toBe('/api/workspace?surface=ai-capture-preview')
    expect(JSON.parse(init.body)).toEqual({ text: '买咖啡', requestId: 'request-1', expectedRevision: 4, timezone: expect.any(String) })
    expect(init.headers.authorization).toBe('Bearer synthetic-token'); expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('retains the original revision on retry after the workspace changes', async () => {
    const first = response({ requestId: 'retry-bound' })
    mocks.fetch.mockResolvedValue(first)
    await previewAiCapture('原输入', 'user-a', 'retry-bound')
    mocks.workspace.mockResolvedValue({ version: 'txn:5' })
    mocks.fetch.mockResolvedValue(Response.json({ code: 'AI_CAPTURE_STALE', message: 'Reinterpret explicitly.' }, { status: 409 }))
    await expect(previewAiCapture('原输入', 'user-a', 'retry-bound')).rejects.toThrow('AI_CAPTURE_STALE')
    expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body).expectedRevision)).toEqual([4, 4])
  })
  it('rejects a response bound to a different request or revision', async () => {
    mocks.fetch.mockResolvedValue(response({ requestId: 'old-request' })); await expect(previewAiCapture('买咖啡', 'user-a', 'request-1')).rejects.toThrow('AI_CAPTURE_INVALID_OUTPUT')
    mocks.fetch.mockResolvedValue(response({ workspaceRevision: 5 })); await expect(previewAiCapture('买咖啡', 'user-a', 'request-1')).rejects.toThrow('AI_CAPTURE_INVALID_OUTPUT')
  })
  it('will not confirm an edited input or another account preview', async () => {
    await expect(confirmAiCapture({ accountKey: 'user-a', commandId: 'command', text: '新内容', preview: preview() })).rejects.toThrow('AI_CAPTURE_REVIEW_REQUIRED')
    await expect(confirmAiCapture({ accountKey: 'user-b', commandId: 'command', text: '买咖啡', preview: preview() })).rejects.toThrow('AI_CAPTURE_REVIEW_REQUIRED')
    expect(mocks.execute).not.toHaveBeenCalled(); expect(isCurrentAiPreview(preview(), '买咖啡', 'user-a')).toBe(true)
  })
  it('passes only durable review identity through existing command receipts and uses exact base revision', async () => {
    const result = await confirmAiCapture({ accountKey: 'user-a', commandId: 'command', text: '买咖啡', preview: preview() })
    expect(mocks.execute).toHaveBeenCalledWith('user-a', { type: 'ai_capture_confirm', value: { requestId: 'request-1' } },
      { commandId: 'command', baseRevision: 4, captureOriginalText: '买咖啡' })
    expect(result.undo).toEqual({ kind: 'connected', accountKey: 'user-a', targetCommandId: 'command' })
  })
  it('recovers an uncertain save using the existing command without any model or preview request', async () => {
    await confirmAiCapture({ accountKey: 'user-a', commandId: 'command', text: '买咖啡', recover: true })
    expect(mocks.confirm).toHaveBeenCalledWith('user-a', 'command'); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('blocks clarification and no-write even if a server incorrectly sets canCommit', async () => {
    mocks.fetch.mockResolvedValue(response({ review: { status: 'no_write', statementMode: 'question', candidates: [], issues: [] } }))
    const result = await previewAiCapture('买咖啡', 'user-a', 'request-1'); expect(result.ai.canCommit).toBe(false)
    await expect(confirmAiCapture({ accountKey: 'user-a', commandId: 'command', text: '买咖啡', preview: result })).rejects.toThrow()
  })
  it('fails honestly when server is default-off instead of using local interpretation', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ code: 'AI_CAPTURE_NOT_ENABLED', message: 'Not enabled' }, { status: 503 }))
    await expect(previewAiCapture('买咖啡', 'user-a', 'request-1')).rejects.toThrow('AI_CAPTURE_NOT_ENABLED'); expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('discards an account switch after await before publishing', async () => {
    mocks.fetch.mockImplementation(async () => { mocks.assert.mockImplementation(() => { throw new Error('Account changed') }); return response() })
    await expect(previewAiCapture('买咖啡', 'user-a', 'request-1')).rejects.toThrow('Account changed')
  })
})


it('binds AI preview to saved workspace timezone and keeps it immutable on retry', async () => {
  const requestId = 'saved-zone-retry'
  mocks.workspace.mockResolvedValue({ version: 'txn:4', snapshot: { data: { timePlanning: { timezone: 'Asia/Shanghai' } } } })
  mocks.fetch.mockImplementation(async () => response({ requestId }))
  await previewAiCapture('明天14点面试', 'user-zone', requestId)
  mocks.workspace.mockResolvedValue({ version: 'txn:5', snapshot: { data: { timePlanning: { timezone: 'UTC' } } } })
  await previewAiCapture('明天14点面试', 'user-zone', requestId)
  expect(mocks.fetch.mock.calls.map(call => JSON.parse(call[1].body).timezone)).toEqual(['Asia/Shanghai', 'Asia/Shanghai'])
  expect(mocks.workspace).toHaveBeenCalledTimes(1)
})
it('rejects an invalid saved AI preview timezone before sending a preview request', async () => {
  mocks.workspace.mockResolvedValue({ version: 'txn:4', snapshot: { data: { timePlanning: { timezone: 'Unknown/Place' } } } })
  await expect(previewAiCapture('明天14点面试', 'user-invalid-zone', 'invalid-zone-request')).rejects.toThrow('AI_CAPTURE_TIMEZONE_REQUIRED')
  expect(mocks.fetch).not.toHaveBeenCalled()
})
