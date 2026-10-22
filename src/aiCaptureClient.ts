import { resolvePlanningTimezone, validPlanningTimezone } from './timePlanningPreferences.js'
import { fetchBackend } from './backendEndpoints.js'
import { captureAccountCacheLease } from './cloud/accountCacheLease.js'
import { getAccountAccessToken } from './cloud/cloudClient.js'
import { fetchConnectedRemoteWorkspace } from './cloud/connectedWorkspaceRepository.js'
import { captureWorkspaceWriteLease } from './cloud/workspaceWriteLease.js'
import { confirmConnectedCommand, executeConnectedBusinessCommand } from './cloud/authoritativeCommandClient.js'
import type { WebSemanticCapturePreview, WebSemanticCaptureResult } from './webSemanticIntake.js'

export function aiCaptureEnabled() { return import.meta.env.VITE_PJSDAS_AI_CAPTURE === 'enabled' }
export interface AiCapturePreview extends WebSemanticCapturePreview {
  ai: { requestId: string; accountKey: string; text: string; timezone: string; referenceTime: string; workspaceRevision: number; canCommit: boolean }
}
// Keep the first request envelope immutable through retries. No credentials or
// model output are retained here; the durable server ledger remains authoritative.
const previewBindings = new Map<string, { text: string; timezone: string; expectedRevision: number }>()
export async function previewAiCapture(text: string, accountKey: string, requestId: string): Promise<AiCapturePreview> {
  const { assertCurrent } = captureAccountCacheLease(accountKey)
  const bindingKey = JSON.stringify([accountKey, requestId])
  let binding = previewBindings.get(bindingKey)
  if (!binding) {
    const workspace = await fetchConnectedRemoteWorkspace(accountKey, assertCurrent)
    assertCurrent()
    const revision = /^txn:(\d+)$/.exec(workspace.version)?.[1]
    if (revision === undefined) throw new Error('AI_CAPTURE_WORKSPACE_REQUIRED: 请先同步已连接的工作区。')
    const timezone = resolvePlanningTimezone(workspace.snapshot.data.timePlanning, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    if (!validPlanningTimezone(timezone)) throw new Error('AI_CAPTURE_TIMEZONE_REQUIRED: 请先核对工作区时区，再整理输入。')
    binding = previewBindings.get(bindingKey) ?? { text, expectedRevision: Number(revision), timezone }
    previewBindings.set(bindingKey, binding)
    if (previewBindings.size > 100) previewBindings.delete(previewBindings.keys().next().value!)
  }
  if (binding.text !== text) throw new Error('AI_CAPTURE_REQUEST_ID_REUSED: 输入已变化，请重新整理。')
  const expectedRevision = binding.expectedRevision
  const token = await getAccountAccessToken(accountKey)
  assertCurrent()
  const response = await fetchBackend('/api/workspace?surface=ai-capture-preview', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, requestId, expectedRevision, timezone: binding.timezone }) })
  assertCurrent()
  const body = await response.json().catch(() => undefined)
  assertCurrent()
  if (!response.ok) throw new Error(`${body?.code ?? 'AI_CAPTURE_FAILED'}: ${body?.message ?? 'AI 理解暂时不可用，没有保存任何内容。'}`)
  const review = body?.review
  if (body?.requestId !== requestId || body?.workspaceRevision !== Number(expectedRevision) || typeof body?.referenceTime !== 'string'
    || !['ready_for_review', 'clarification_required', 'no_write', 'invalid_output', 'stale'].includes(review?.status)
    || !['assertion', 'current_intent', 'question', 'quote', 'example', 'hypothetical', 'rewrite_request'].includes(review?.statementMode)
    || !Array.isArray(review?.candidates) || review.candidates.length > 12 || !Array.isArray(review?.issues)
    || review.issues.some((issue: unknown) => !issue || typeof (issue as { message?: unknown }).message !== 'string')) {
    throw new Error('AI_CAPTURE_INVALID_OUTPUT: AI 预览不完整，没有保存任何内容。')
  }
  return { mode: review.statementMode, candidates: review.candidates, unresolved: review.issues.map((issue: { message: string }) => issue.message), ignored: [],
    ai: { requestId, accountKey, text, timezone: binding.timezone, referenceTime: body.referenceTime, workspaceRevision: body.workspaceRevision,
      canCommit: body.canCommit === true && review.status === 'ready_for_review' && ['assertion', 'current_intent'].includes(review.statementMode) } }
}

export function isCurrentAiPreview(preview: WebSemanticCapturePreview | undefined, text: string, accountKey: string | null): preview is AiCapturePreview {
  const ai = (preview as AiCapturePreview | undefined)?.ai
  return Boolean(ai && ai.accountKey === accountKey && ai.text === text)
}

/** Confirmation carries only a durable preview ID. The server retrieves the
 * exact reviewed observation; no model candidates become client write authority. */
export async function confirmAiCapture(options: { accountKey: string; commandId: string; text: string; preview?: AiCapturePreview; recover?: boolean }): Promise<WebSemanticCaptureResult> {
  const { assertCurrent } = captureWorkspaceWriteLease(options.accountKey)
  if (!options.recover && (!isCurrentAiPreview(options.preview, options.text, options.accountKey) || !options.preview.ai.canCommit)) {
    throw new Error('AI_CAPTURE_REVIEW_REQUIRED: 请先整理输入并核对最新 AI 预览。')
  }
  const result = options.recover ? await confirmConnectedCommand(options.accountKey, options.commandId)
    : await executeConnectedBusinessCommand(options.accountKey, { type: 'ai_capture_confirm', value: { requestId: options.preview!.ai.requestId } },
      { commandId: options.commandId, baseRevision: options.preview!.ai.workspaceRevision, captureOriginalText: options.text })
  assertCurrent()
  if (result.outcome === 'CONFLICT') throw new Error(`CONFLICT: ${result.conflict?.message ?? '工作区已变化，请重新整理并核对。'}`)
  const status = String(result.result?.status ?? (result.outcome === 'ALREADY_APPLIED' ? 'ALREADY_APPLIED' : 'NO_WRITE')) as WebSemanticCaptureResult['status']
  return { status, summary: typeof result.result?.summary === 'string' ? result.result.summary : '已处理核对后的内容。', unresolved: [], ignored: [],
    decisionRequestIds: Array.isArray(result.result?.decisionRequestIds) ? result.result.decisionRequestIds.filter((id): id is string => typeof id === 'string') : [],
    undo: result.receipt?.undoAvailable === true ? { kind: 'connected', accountKey: options.accountKey, targetCommandId: options.commandId } : undefined }
}
