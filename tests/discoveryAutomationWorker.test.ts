import { offlineSearchFixture } from './fixtures/discoverySearch.rebuilt.js'
import { recruitingPagesFixture } from './fixtures/verifiedDiscovery.js'
import { syntheticDiscoveryBudget } from './fixtures/discoveryBudget.js'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyDiscoveryAutomationRunState,
  discoverSourceRun,
  retrieveDiscoverySourceRun,
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
    webQueries: [{ query: 'AI 产品经理 北京 校招 截止 新增', coverage: 'general_web' }],
    refreshTargets: [],
    maxObservations: 6,
  }
}

function fundedSearch() {
  return { ...syntheticDiscoveryBudget, ...offlineSearchFixture([{ url: 'https://www.liepin.com/job/9301.shtml', title: 'AI Product Manager' }]) }
}

function generator(content: string, seen?: DiscoveryGenerateTextInput[]): DiscoveryGenerateText {
  return vi.fn(async (input) => {
    seen?.push(input)
    return { text: content }
  })
}

describe('discovery automation completion state', () => {
  it('separates a successful check from durable source completion', () => {
    expect(classifyDiscoveryAutomationRunState({
      configured: false, dueSourceCount: 0, completedSourceCount: 0, unresolvedCount: 0,
    })).toBe('not_configured')
    expect(classifyDiscoveryAutomationRunState({
      configured: true, dueSourceCount: 0, completedSourceCount: 0, unresolvedCount: 0,
    })).toBe('checked_not_due')
    expect(classifyDiscoveryAutomationRunState({
      configured: true, dueSourceCount: 2, completedSourceCount: 0, unresolvedCount: 0,
    })).toBe('verified_not_committed')
    expect(classifyDiscoveryAutomationRunState({
      configured: true, dueSourceCount: 2, completedSourceCount: 2, unresolvedCount: 0,
    })).toBe('committed')
    expect(classifyDiscoveryAutomationRunState({
      configured: true, dueSourceCount: 2, completedSourceCount: 2, unresolvedCount: 1,
    })).toBe('committed_with_exceptions')
  })
})

describe('server-owned discovery worker model boundary', () => {
  it('accepts only bounded structured source-backed observations and sends the bounded prompt through AI SDK', async () => {
    const snapshot = await demoSnapshot()
    const seen: DiscoveryGenerateTextInput[] = []
    const generateTextImpl = generator(JSON.stringify({ observations: [{
      sourceRecordId: 'job-123',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://www.liepin.com/job/9301.shtml',
      sourceTitle: 'AI Product Manager - 2027 Campus',
      location: 'Beijing',
      postingStatus: 'open',
    }] }), seen)

    const observations = await discoverSourceRun(snapshot, sourceRun(), {
      executionRules: ['Use exact source identity.', 'Unknown facts remain unknown.'],
      incrementalSince: '2026-09-14T01:00:00.000Z',
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { ...fundedSearch(), generateTextImpl },
      fetchImpl: recruitingPagesFixture([{ company: 'Example AI', role: 'AI Product Manager', sourceUrl: 'https://www.liepin.com/job/9301.shtml', location: 'Beijing' }]),
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      sourceRecordId: expect.any(String),
      company: 'Example AI',
      sourceVerification: 'verified',
      sourceTitle: 'AI Product Manager - Example AI',
      postingStatus: 'unknown',
      location: 'Beijing',
    })
    expect(observations[0].sourceRecordId).toBe(observations[0].sourceProof?.postingIdentity)
    expect(observations[0].sourceProof?.authority).toBe('recruiting_platform')
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

  it('accepts actual empty search-provider evidence without invoking the model', async () => {
    const snapshot = await demoSnapshot(), search = offlineSearchFixture(), generateTextImpl = generator('{"observations":[]}')
    const result = await retrieveDiscoverySourceRun(snapshot, sourceRun(), { executionRules: [], now: new Date('2026-09-15T01:00:00Z'),
      ai: { ...syntheticDiscoveryBudget, ...search, generateTextImpl } })
    expect(result.observations).toEqual([]); expect(result.omittedHitCount).toBe(0)
    expect(result.executions).toEqual([expect.objectContaining({ outcome: 'empty', resultCount: 0, providerRequestId: expect.any(String) })])
    expect(search.queries).toHaveLength(1); expect(search.reservations).toHaveLength(1)
    expect(generateTextImpl).not.toHaveBeenCalled()
  })

  it('does not treat empty model interpretation as evidence that retrieved hits were not jobs', async () => {
    const result = await retrieveDiscoverySourceRun(await demoSnapshot(), sourceRun(), { executionRules: [], now: new Date('2026-09-15T01:00:00Z'),
      ai: { ...fundedSearch(), generateTextImpl: generator('{"observations":[]}') } })
    expect(result.observations).toEqual([]); expect(result.omittedHitCount).toBe(1)
    expect(result.executions[0]).toMatchObject({ outcome: 'success', resultCount: 1 })
  })

  it('fails closed on malformed or non-source-backed model output instead of inventing missing fields', async () => {
    const snapshot = await demoSnapshot()
    const generateTextImpl = generator(JSON.stringify({ observations: [{
      sourceRecordId: 'job-without-url',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceTitle: 'AI Product Manager',
    }] }))

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { ...fundedSearch(), generateTextImpl },
    })).rejects.toMatchObject({ code: 'DISCOVERY_MODEL_INVALID' })
  })

  it('fails closed when the model duplicates a sourceRecordId inside one batch', async () => {
    const snapshot = await demoSnapshot()
    const base = {
      sourceRecordId: 'job-duplicate',
      company: 'Example AI',
      role: 'AI Product Manager',
      sourceUrl: 'https://www.liepin.com/job/9301.shtml',
      sourceTitle: 'AI Product Manager',
    }

    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { ...fundedSearch(), generateTextImpl: generator(JSON.stringify({ observations: [base, base] })) },
    })).rejects.toMatchObject({ code: 'DISCOVERY_MODEL_INVALID' })
  })

  it('maps AI SDK provider status codes without exposing raw provider errors', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { ...fundedSearch(),
        generateTextImpl: async () => { throw { statusCode: 429, message: 'provider-private-detail' } },
      },
    })).rejects.toMatchObject({
      code: 'DISCOVERY_MODEL_UNAVAILABLE',
      retryable: false,
      message: expect.not.stringContaining('provider-private-detail'),
    })
  })

  it('distinguishes Vercel customer verification from authentication failure', async () => {
    const snapshot = await demoSnapshot()
    await expect(discoverSourceRun(snapshot, sourceRun(), {
      executionRules: [],
      now: new Date('2026-09-15T01:00:00.000Z'),
      ai: { ...fundedSearch(),
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
      ai: { ...fundedSearch(),
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
      ai: { ...fundedSearch(),
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
      ai: { ...fundedSearch(),
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
      ai: { ...fundedSearch(),
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
      sourceUrl: 'https://www.liepin.com/job/9301.shtml',
      sourceTitle: 'Model supplied title',
      location: 'Beijing',
      deadline: '2026-10-10',
      compensationText: '300k RMB',
      rationale: 'Model says this is the job.',
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
      sourceVerificationReason: expect.stringContaining('DISCOVERY_SOURCE_UNVERIFIED'),
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
      sourceUrl: 'https://www.liepin.com/job/9302.shtml',
      sourceTitle: 'Example',
      rationale: 'Example',
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
      sourceUrl: 'https://www.liepin.com/job/9301.shtml',
      sourceTitle: 'Model title',
      location: 'Shanghai',
      deadline: '2026-10-10',
      compensationText: '300k RMB',
      rationale: 'Model assessment.',
      postingStatus: 'open',
    }, {
      now: new Date('2026-09-19T00:00:00.000Z'),
      fetchImpl: recruitingPagesFixture([{ company: 'Example AI', role: 'AI Product Manager', sourceUrl: 'https://www.liepin.com/job/9301.shtml' }]),
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
