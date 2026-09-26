// Read-only, bounded production telemetry. Never print account IDs, cursors,
// pending message IDs, mail content, raw provider responses or secret values.
const key = process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY
if (!key) throw new Error('Production telemetry credential is unavailable')
const origin = 'https://yyrzwpoxlxpafdlbkdtg.supabase.co'
const allowedCode = new Set([
  'BUDGET_EXHAUSTED', 'LEASE_LOST', 'GOOGLE_AUTH_EXPIRED',
  'GOOGLE_GMAIL_API_DISABLED', 'GOOGLE_GMAIL_FORBIDDEN',
  'GOOGLE_GMAIL_SCOPE_MISSING', 'GOOGLE_ACCOUNT_MISMATCH',
  'GOOGLE_REFRESH_FAILED', 'GMAIL_REQUEST_FAILED',
  'GMAIL_RESPONSE_INVALID', 'GMAIL_UNAVAILABLE',
  'WORKSPACE_CONFLICT', 'AUTH_UNAVAILABLE', 'AUTOMATION_FAILED',
])
const allowedOperation = new Set(['profile', 'history', 'list', 'message_fetch', 'unknown'])
const allowedScope = new Set(['run', 'record'])
function boundedReason(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value : null
}
function ageMinutes(value) {
  if (!value) return null
  const milliseconds = Date.now() - Date.parse(value)
  return Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 60000)) : null
}
async function read(table, select, filter = '') {
  const url = new URL(origin + '/rest/v1/' + table)
  url.searchParams.set('select', select)
  url.searchParams.set('limit', '100')
  if (filter) url.searchParams.set('gmail_automation_enabled', 'eq.true')
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('Production telemetry read failed: HTTP ' + response.status)
  const rows = await response.json()
  if (!Array.isArray(rows) || rows.length >= 100) throw new Error('Production telemetry response is invalid or truncated')
  return rows
}
try {
  const bindings = await read('google_drive_connections',
    'user_id,gmail_last_checked_at,gmail_last_success_at,gmail_last_error,gmail_pending_message_ids', true)
  const executions = await read('gmail_automation_execution_state',
    'user_id,completed_at,completed_runs,failed_runs,last_metrics')
  const byUser = new Map(executions.map((row) => [row.user_id, row]))
  const summary = {
    observedAt: new Date().toISOString(),
    enabledBindings: bindings.length,
    checkedWithin20m: 0,
    successfulWithin20m: 0,
    pendingRecordCount: 0,
    lastChecksAgeMinutes: [],
    lastSuccessAgeMinutes: [],
    diagnostics: [],
  }
  for (const binding of bindings) {
    const checkedAge = ageMinutes(binding.gmail_last_checked_at)
    const successAge = ageMinutes(binding.gmail_last_success_at)
    summary.lastChecksAgeMinutes.push(checkedAge)
    summary.lastSuccessAgeMinutes.push(successAge)
    if (checkedAge !== null && checkedAge <= 20) summary.checkedWithin20m++
    if (successAge !== null && successAge <= 20) summary.successfulWithin20m++
    if (Array.isArray(binding.gmail_pending_message_ids)) {
      summary.pendingRecordCount += binding.gmail_pending_message_ids.length
    }
    const metrics = byUser.get(binding.user_id)?.last_metrics ?? {}
    const code = allowedCode.has(metrics.errorCode) ? metrics.errorCode
      : allowedCode.has(String(binding.gmail_last_error ?? '').split(/[ :]/)[0])
        ? String(binding.gmail_last_error).split(/[ :]/)[0] : null
    summary.diagnostics.push({
      status: metrics.status === 'completed' || metrics.status === 'error' ? metrics.status : null,
      errorCode: code,
      providerOperation: allowedOperation.has(metrics.providerOperation) ? metrics.providerOperation : null,
      providerStatus: Number.isInteger(metrics.providerStatus)
        && metrics.providerStatus >= 100 && metrics.providerStatus <= 599 ? metrics.providerStatus : null,
      providerReason: boundedReason(metrics.providerReason),
      failureScope: allowedScope.has(metrics.failureScope) ? metrics.failureScope : null,
      recordGapCount: Number.isInteger(metrics.recordGapCount)
        && metrics.recordGapCount >= 0 && metrics.recordGapCount <= 100 ? metrics.recordGapCount : null,
    })
  }
  console.log(JSON.stringify(summary))
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production telemetry read failed')
  process.exitCode = 1
}
