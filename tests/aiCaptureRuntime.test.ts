import { describe, expect, it } from 'vitest'
import { createConfiguredAiCaptureRuntime } from '../gateway/aiCaptureRuntime.js'
import { createAiCaptureLedger } from '../gateway/aiCaptureLedger.js'

describe('capture runtime activation gates', () => {
  const config = { supabaseUrl: 'https://example.test', serviceRoleKey: 'synthetic-only' }
  it('defaults off, and an existing gateway key never activates capture', () => {
    expect(createConfiguredAiCaptureRuntime({ ...config, env: {} })).toBeUndefined()
    expect(createConfiguredAiCaptureRuntime({ ...config, env: { AI_GATEWAY_API_KEY: 'synthetic-key' } })).toBeUndefined()
  })
  it('requires all independent activation metadata and a positive worst-case bound', () => {
    const env = { PJSDAS_AI_CAPTURE: 'enabled', PJSDAS_AI_CAPTURE_FUNDING: 'verified-free-only-no-overage', PJSDAS_AI_CAPTURE_MAX_RESERVATION_UNITS: '100' }
    for (const key of Object.keys(env)) expect(createConfiguredAiCaptureRuntime({ ...config, env: { ...env, [key]: undefined } })).toBeUndefined()
    expect(createConfiguredAiCaptureRuntime({ ...config, env })).toBeDefined()
    expect(createConfiguredAiCaptureRuntime({ ...config, env: { ...env, PJSDAS_AI_CAPTURE_MAX_RESERVATION_UNITS: '0' } })).toBeUndefined()
  })
  it('treats an unknown admission response as a hard stop, never retries', async () => {
    let calls = 0
    const ledger = createAiCaptureLedger({ ...config, fetchImpl: async () => { calls++; throw new Error('synthetic lost response') } })
    await expect(ledger.admit({ userId: 'user', requestId: 'test', text: 'text', timezone: 'UTC', referenceTime: '2026-10-19T00:00:00Z', expectedRevision: 0, payloadHash: 'a'.repeat(64), reservationUnits: 100 })).rejects.toMatchObject({ code: 'AI_CAPTURE_LEDGER_UNAVAILABLE', retryable: false })
    expect(calls).toBe(1)
  })
})
