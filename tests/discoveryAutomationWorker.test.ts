import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { discoverSourceRun } from '../gateway/discoveryAutomationWorker.js'
import type { DiscoveryAutomationSourcePlan } from '../src/discoveryAutomation.js'
import type { PJSDASSnapshot } from '../src/snapshot.js'

async function demoSnapshot() {
  return JSON.parse(await readFile(new URL('../gateway/fixtures/demo-workspace.json', import.meta.url), 'utf8')) as PJSDASSnapshot
}

function sourceRun(): DiscoveryAutomationSourcePlan {
  return {
    sourceId: 'monitor:urgent-campus',
    label: '秋招紧迫岗位检查',
    cadenceMinutes: 1440,
    freshnessSlaMinutes: 2160,
    objective: 'Find urgent current campus recruiting opportunities.',
    queryHints: ['AI 产品经理 北京 校招 截止 新增'],
    refreshTargets: [],
    maxObservations: 6,
  }
}

function gatewayResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('server-owned discovery worker model boundary', () => {
  it('accepts only bounded structured source-backed observations and sends the deployment credential to AI Gateway', async () => {
    const snapshot = await demoSnapshot()
    const seen: Array<{ auth: string | null; body: any }> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body ?? '{}')),
      })
      return gatewayResponse(JSON.stringify({ observations: [{
        sourceRecordId: 'job-123',
        company: 'Example AI',
        role: 'AI Product Manager',
        sourceUrl: 'https://careers.example.com/jobs/123',
        sourceTitle: 'AI Product Manager - 2027 Campus',
        location: 'Beijing',
        rationale: 'Official employer posting matches the explicit target role.',
        roleType: 'core',
        opportunityValue: 75,
        fitScore: 80,
        fitConfidence: 'medium',
        opportunityValueConfidence: 'medium',
        postingStatus: 'open',
        discoveredAt: '2026-09-15T01:00:00.000Z',
      }] }))
    }) as unknown as typeof fetch

    const observations = await discoverSourceRun(snapshot, sourceRun(), {
      executionRules: ['Use exact source identity.', 'Unknown facts remain unknown.'],
      incrementalSince: '2026-09-14T01:00:00.000Z',
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { token: 'gateway-token', fetchImpl },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ sourceRecordId: 'job-123', company: 'Example AI', fitScore: 80 })
    expect(seen[0]?.auth).toBe('Bearer gateway-token')
    expect(seen[0]?.body.model).toBe('perplexity/sonar')
    expect(String(seen[0]?.body.messages?.[1]?.content)).toContain('AI 产品经理 北京 校招 截止 新增')
    expect(String(seen[0]?.body.messages?.[1]?.content)).toContain('2026-09-14T01:00:00.000Z')
  })

  it('accepts an explicit zero-result completed search', async () => {
    const snapshot = await demoSnapshot()
    const fetchImpl = vi.fn(async () => gatewayResponse('{"observations":[]}')) as unknown as typeof fetch
    const observations = await discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { token: 'gateway-token', fetchImpl },
    })
    expect(observations).toEqual([])
  })

  it('fails closed on malformed or non-source-backed model output instead of inventing missing fields', async () => {
    const snapshot = await demoSnapshot()
    const fetchImpl = vi.fn(async () => gatewayResponse(JSON.stringify({ observations: [{
      sourceRecordId: 'job-without-url',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceTitle: 'AI Product Manager',
      rationale: 'Looks relevant.',
      roleType: 'core',
      opportunityValue: 80,
      fitScore: 80,
      fitConfidence: 'high',
      opportunityValueConfidence: 'high',
    }] }))) as unknown as typeof fetch

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { token: 'gateway-token', fetchImpl },
    })).rejects.toMatchObject({ code: 'DISCOVERY_MODEL_INVALID' })
  })

  it('fails closed when the model duplicates a sourceRecordId inside one batch', async () => {
    const snapshot = await demoSnapshot()
    const base = {
      sourceRecordId: 'job-duplicate',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/jobs/123',
      sourceTitle: 'AI Product Manager',
      rationale: 'Official source.',
      roleType: 'core',
      opportunityValue: 70,
      fitScore: 70,
      fitConfidence: 'medium',
      opportunityValueConfidence: 'medium',
    }
    const fetchImpl = vi.fn(async () => gatewayResponse(JSON.stringify({ observations: [base, base] }))) as unknown as typeof fetch

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { token: 'gateway-token', fetchImpl },
    })).rejects.toMatchObject({ code: 'DISCOVERY_MODEL_INVALID' })
  })
})
