import type { GmailExecutionMetrics } from './gmailExecutionMetrics.js'
import { WorkspaceSourceError } from './workspaceSource.js'

export type GmailProviderOperation = 'profile' | 'history' | 'list' | 'message_fetch' | 'unknown'

type GoogleApiErrorPayload = {
  error?: {
    status?: string
    errors?: Array<{ reason?: string }>
    details?: Array<{ reason?: string }>
  }
}

function safeReason(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_.-]{1,80}$/.test(trimmed) ? trimmed : undefined
}

export async function gmailProviderReason(response: Response) {
  const payload = await response.clone().json().catch(() => undefined) as GoogleApiErrorPayload | undefined
  const candidates = [
    payload?.error?.status,
    ...(payload?.error?.errors ?? []).map((item) => item.reason),
    ...(payload?.error?.details ?? []).map((item) => item.reason),
  ]
  return candidates.map(safeReason).find(Boolean)
}

export class GmailProviderRequestError extends WorkspaceSourceError {
  readonly operation: GmailProviderOperation
  readonly httpStatus: number
  readonly providerReason?: string
  readonly failureScope = 'run' as const

  constructor(input: {
    code: string
    message: string
    retryable: boolean
    operation: GmailProviderOperation
    httpStatus: number
    providerReason?: string
  }) {
    super(input.code, input.message, input.retryable)
    this.name = 'GmailProviderRequestError'
    this.operation = input.operation
    this.httpStatus = input.httpStatus
    this.providerReason = input.providerReason
  }
}

export async function gmailProviderRequestError(
  response: Response,
  operation: GmailProviderOperation,
  code: string,
  message: string,
  retryable: boolean,
) {
  return new GmailProviderRequestError({
    code,
    message,
    retryable,
    operation,
    httpStatus: response.status,
    providerReason: await gmailProviderReason(response),
  })
}

export function gmailFailureMetrics(caught: unknown): Partial<GmailExecutionMetrics> {
  if (!(caught instanceof GmailProviderRequestError)) return {}
  return {
    providerOperation: caught.operation,
    providerStatus: caught.httpStatus,
    providerReason: caught.providerReason,
    failureScope: caught.failureScope,
  }
}
