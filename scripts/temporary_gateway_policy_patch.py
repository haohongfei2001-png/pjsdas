from pathlib import Path

worker = Path('gateway/discoveryAutomationWorker.ts')
text = worker.read_text()
old = """function gatewayErrorDetails(caught: unknown) {
  if (!caught || typeof caught !== 'object') return { type: undefined, message: undefined }
  const candidate = caught as { responseBody?: unknown; data?: unknown }
  let payload: unknown = candidate.data
  if (typeof candidate.responseBody === 'string') {
    try {
      payload = JSON.parse(candidate.responseBody) as unknown
    } catch {
      // Non-JSON provider bodies are intentionally not surfaced.
    }
  }
  if (!payload || typeof payload !== 'object') return { type: undefined, message: undefined }
  const root = payload as Record<string, unknown>
  const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
  return {
    type: typeof nested.type === 'string' ? nested.type : undefined,
    message: typeof nested.message === 'string'
      ? nested.message
      : typeof root.error === 'string'
        ? root.error
        : undefined,
  }
}
"""
new = """function safeGatewayRuleId(value: unknown) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,160}$/.test(trimmed) ? trimmed : undefined
}

function gatewayErrorDetails(caught: unknown) {
  if (!caught || typeof caught !== 'object') return { type: undefined, message: undefined, ruleId: undefined }
  const candidate = caught as {
    type?: unknown
    message?: unknown
    ruleId?: unknown
    responseBody?: unknown
    data?: unknown
  }
  const direct = {
    type: typeof candidate.type === 'string' ? candidate.type : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    ruleId: safeGatewayRuleId(candidate.ruleId),
  }
  let payload: unknown = candidate.data
  if (typeof candidate.responseBody === 'string') {
    try {
      payload = JSON.parse(candidate.responseBody) as unknown
    } catch {
      // Non-JSON provider bodies are intentionally not surfaced.
    }
  }
  if (!payload || typeof payload !== 'object') return direct
  const root = payload as Record<string, unknown>
  const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root
  const param = nested.param && typeof nested.param === 'object' ? nested.param as Record<string, unknown> : undefined
  return {
    type: typeof nested.type === 'string' ? nested.type : direct.type,
    message: typeof nested.message === 'string'
      ? nested.message
      : typeof root.error === 'string'
        ? root.error
        : direct.message,
    ruleId: safeGatewayRuleId(param?.ruleId) ?? direct.ruleId,
  }
}
"""
if old not in text:
    raise SystemExit('gatewayErrorDetails block not found')
text = text.replace(old, new, 1)
old2 = """  if (status === 403) {
    if (details.type === 'customer_verification_required') {
"""
new2 = """  if (status === 403) {
    if (details.type === 'forbidden') {
      const ruleSuffix = details.ruleId ? ` (routing rule ${details.ruleId})` : ''
      throw new WorkspaceSourceError(
        'DISCOVERY_MODEL_POLICY_FORBIDDEN',
        `Vercel AI Gateway routing policy denied the discovery-model request${ruleSuffix}.`,
        false,
      )
    }
    if (details.type === 'customer_verification_required') {
"""
if old2 not in text:
    raise SystemExit('403 block marker not found')
worker.write_text(text.replace(old2, new2, 1))

tests = Path('tests/discoveryAutomationWorker.test.ts')
test_text = tests.read_text()
marker = "  it('classifies the official top-level no_providers_available Gateway shape as a team restriction', async () => {\n"
addition = """  it('classifies AI SDK GatewayForbiddenError metadata as a routing-policy denial', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => {
          throw {
            name: 'GatewayForbiddenError',
            statusCode: 403,
            type: 'forbidden',
            ruleId: 'rule_test_123',
            message: 'Forbidden by routing policy',
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_POLICY_FORBIDDEN',
      retryable: false,
      message: expect.stringContaining('rule_test_123'),
    })
  })

"""
if marker not in test_text:
    raise SystemExit('test insertion marker not found')
tests.write_text(test_text.replace(marker, addition + marker, 1))
