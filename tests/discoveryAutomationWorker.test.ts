import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverSourceRun,
  type DiscoveryGenerateText,
  type DiscoveryGenerateTextInput,
} from '../gateway/discoveryAutomationWorker.js'
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

function generator(content: string, seen?: DiscoveryGenerateTextInput[]): DiscoveryGenerateText {
  return vi.fn(async (input) => {
    seen?.push(input)
    return { text: content }
  })
}

describe('server-owned discovery worker model boundary', () => {
  it('accepts only bounded structured source-backed observations and sends the bounded prompt through AI SDK', async () => {
    const snapshot = await demoSnapshot()
    const seen: DiscoveryGenerateTextInput[] = []
    const generateTextImpl = generator(JSON.stringify({ observations: [{
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
    }] }), seen)

    const observations = await discoverSourceRun(snapshot, sourceRun(), {
      executionRules: ['Use exact source identity.', 'Unknown facts remain unknown.'],
      incrementalSince: '2026-09-14T01:00:00.000Z',
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { generateTextImpl },
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ sourceRecordId: 'job-123', company: 'Example AI', fitScore: 80 })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      model: 'perplexity/sonar',
      temperature: 0.1,
      maxOutputTokens: 5000,
    })
    expect(seen[0]?.system).toContain('citation-grounded public job discovery')
    expect(seen[0]?.prompt).toContain('AI 产品经理 北京 校招 截止 新增')
    expect(seen[0]?.prompt).toContain('2026-09-14T01:00:00.000Z')
  })

  it('accepts an explicit zero-result completed search', async () => {
    const snapshot = await demoSnapshot()
    const observations = await discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { generateTextImpl: generator('{"observations":[]}') },
    })
    expect(observations).toEqual([])
  })

  it('fails closed on malformed or non-source-backed model output instead of inventing missing fields', async () => {
    const snapshot = await demoSnapshot()
    const generateTextImpl = generator(JSON.stringify({ observations: [{
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
    }] }))

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { generateTextImpl },
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

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { generateTextImpl: generator(JSON.stringify({ observations: [base, base] })) },
    })).rejects.toMatchObject({ code: 'DISCOVERY_MODEL_INVALID' })
  })

  it('maps AI SDK provider status codes without exposing raw provider errors', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => { throw { statusCode: 429, message: 'provider-private-detail' } },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_UNAVAILABLE',
      retryable: true,
      message: expect.not.stringContaining('provider-private-detail'),
    })
  })

  it('distinguishes Vercel customer verification from authentication failure', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => {
          throw {
            statusCode: 403,
            responseBody: JSON.stringify({
              error: {
                type: 'customer_verification_required',
                message: 'Payment method verification required.',
              },
            }),
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_CUSTOMER_VERIFICATION_REQUIRED',
      retryable: false,
    })
  })

  it('distinguishes Gateway budget quota from missing credits', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => {
          throw {
            statusCode: 402,
            data: {
              error: {
                type: 'quota_for_entity_exceeded',
                message: 'Project budget reached.',
              },
            },
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_QUOTA_EXCEEDED',
      retryable: false,
    })
  })

  it('distinguishes a free-tier model restriction from project authentication failure', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => {
          throw {
            statusCode: 403,
            responseBody: JSON.stringify({
              error: {
                type: 'forbidden',
                message: 'This model is unavailable on the free tier.',
              },
            }),
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_CREDITS_REQUIRED',
      retryable: false,
    })
  })
})
