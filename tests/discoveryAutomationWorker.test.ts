import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverSourceRun,
  verifyDiscoverySourceObservation,
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
      sourceRecordId: expect.stringMatching(/^verified:/),
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
      fetchImpl: vi.fn(async () => new Response(
        '<html><head><title>AI Product Manager - Example AI</title></head><body>Example AI AI Product Manager 2027 Campus Beijing</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch,
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      sourceRecordId: 'job-123',
      company: 'Example AI',
      fitScore: 80,
      sourceVerification: 'verified',
      sourceTitle: 'AI Product Manager - Example AI',
      postingStatus: 'unknown',
      location: 'Beijing',
    })
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

  it('classifies AI SDK GatewayForbiddenError metadata as a routing-policy denial', async () => {
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

  it('classifies the official top-level no_providers_available Gateway shape as a team restriction', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: {
        generateTextImpl: async () => {
          throw {
            statusCode: 403,
            responseBody: JSON.stringify({
              error: 'Your team has restricted access to this model. Contact the owner of the account for more details.',
              type: 'no_providers_available',
              statusCode: 403,
            }),
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_RESTRICTED',
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
  it('marks a model citation unverified when the fetched page does not corroborate company and role', async () => {
    const observation = await verifyDiscoverySourceObservation({
      sourceRecordId: 'job-mismatch',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/jobs/123',
      sourceTitle: 'Model supplied title',
      location: 'Beijing',
      deadline: '2026-10-10',
      compensationText: '300k RMB',
      rationale: 'Model says this is the job.',
      roleType: 'core',
      opportunityValue: 88,
      fitScore: 90,
      fitConfidence: 'high',
      opportunityValueConfidence: 'high',
      postingStatus: 'open',
    }, {
      now: new Date('2026-09-19T00:00:00.000Z'),
      fetchImpl: vi.fn(async () => new Response(
        '<html><head><title>Completely Different Employer</title></head><body>Software Engineer opening</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch,
    })

    expect(observation).toMatchObject({
      sourceVerification: 'unverified',
      sourceVerificationReason: expect.stringContaining('corroborate'),
    })
  })

  it('rejects redirects to private/local source destinations instead of following them', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/internal' },
    })) as unknown as typeof fetch

    const observation = await verifyDiscoverySourceObservation({
      sourceRecordId: 'job-redirect',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/jobs/redirect',
      sourceTitle: 'Example',
      rationale: 'Example',
      roleType: 'core',
      opportunityValue: 70,
      fitScore: 70,
      fitConfidence: 'medium',
      opportunityValueConfidence: 'medium',
    }, { fetchImpl })

    expect(observation).toMatchObject({
      sourceVerification: 'unverified',
      sourceVerificationReason: expect.stringContaining('DISCOVERY_SOURCE_INVALID'),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps model-derived optional facts unknown unless the fetched source literally supports them', async () => {
    const observation = await verifyDiscoverySourceObservation({
      sourceRecordId: 'job-facts',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://careers.example.com/jobs/123',
      sourceTitle: 'Model title',
      location: 'Shanghai',
      deadline: '2026-10-10',
      compensationText: '300k RMB',
      rationale: 'Model assessment.',
      roleType: 'core',
      opportunityValue: 80,
      fitScore: 80,
      fitConfidence: 'medium',
      opportunityValueConfidence: 'medium',
      postingStatus: 'open',
    }, {
      now: new Date('2026-09-19T00:00:00.000Z'),
      fetchImpl: vi.fn(async () => new Response(
        '<html><head><title>Example AI - AI Product Manager</title></head><body>Example AI is hiring an AI Product Manager in Beijing.</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch,
    })

    expect(observation).toMatchObject({
      sourceVerification: 'verified',
      postingStatus: 'unknown',
    })
    expect(observation.location).toBeUndefined()
    expect(observation.deadline).toBeUndefined()
    expect(observation.compensationText).toBeUndefined()
  })

})
