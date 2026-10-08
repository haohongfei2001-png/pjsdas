import { voiceOverTest } from '@guidepup/playwright'
import { expect } from '@playwright/test'
import { guardMockApplicationRequests, proveMockApplicationGuard } from './mockApplicationRequests.js'

/** Limited to the existing VoiceOver suite. Never used for a live target. */
export const test = voiceOverTest.extend({
  context: async ({ context, browser, browserName, channel, headless, connectOptions, serviceWorkers }, use, info) => {
    expect(browserName).toBe('chromium')
    expect(headless).toBe(false)
    expect(Boolean(channel)).toBe(false)
    expect(Boolean(connectOptions || process.env.PW_TEST_CONNECT_WS_ENDPOINT)).toBe(false)
    expect(browser.version()).toBe('153.0.8010.12')
    expect(serviceWorkers).toBe('block')
    const guard = await guardMockApplicationRequests(context)
    let proof: Awaited<ReturnType<typeof proveMockApplicationGuard>> | undefined
    try { proof = await proveMockApplicationGuard(context, guard); await use(context) } finally {
      // Finish application activity before recording the final guard result.
      await context.close()
      await info.attach('mock-application-requests.json', { body: JSON.stringify({ browser: browser.version(), proof: proof ?? null, blocked: guard.blocked }), contentType: 'application/json' })
      const counts = (records: typeof guard.blocked) => Object.fromEntries(['http', 'websocket', 'serviceworker'].map(kind => [kind, records.filter(record => record.kind === kind).length]))
      console.log(`VoiceOver application guard evidence: ${JSON.stringify({ browser: browser.version(), proofCompleted: Boolean(proof), proofAttempts: counts(proof ?? []), unexpectedApplicationAttempts: counts(guard.blocked) })}`)
      if (proof) guard.assertNoUnexpectedRequests()
    }
  },
})
