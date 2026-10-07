import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScheduleWindowList } from '../src/schedule/ScheduleFeature.js'
import type { ScheduleStream } from '../src/schedule/scheduleStream.js'

const state = vi.hoisted(() => ({ language: 'en' }))
vi.mock('../src/uiLanguage.js', () => ({ useUiLanguage: () => ({ lang: state.language }) }))
function stream(occurredAt: string): ScheduleStream {
  return { accountKey: 'synthetic', workspaceRevision: '1', timezone: 'America/Los_Angeles', evaluatedAt: '2026-10-06T12:00:00Z', key: 'synthetic',
    sections: { upcoming: [], unresolved: [], undated: [], no_deadline: [], history: [{ id: 'fact', kind: 'business_fact', section: 'history', title: 'Applied', date: '2026-10-02', occurredAt, sourceRefs: [] }] },
    counts: { upcoming: 0, unresolved: 0, history: 1, undated: 0, no_deadline: 0 },
    positions: { upcoming: new Map(), unresolved: new Map(), undated: new Map(), no_deadline: new Map(), history: new Map([['fact', 0]]) } }
}

describe('actual event time display', () => {
  it.each(['en', 'zh'])('keeps a date-only event honest in %s', language => {
    state.language = language
    const html = renderToStaticMarkup(<ScheduleWindowList stream={stream('2026-10-02')} section="history" opportunities={[]} onOpenOpportunity={() => {}} />)
    expect(html).toContain(language === 'zh' ? '2026-10-02 · 具体时间待定' : '2026-10-02 · Exact time TBD')
    expect(html).not.toContain('00:00')
    expect(html).not.toContain('10/1')
  })
  it('retains the supplied exact instant in the display timezone', () => {
    state.language = 'en'
    const html = renderToStaticMarkup(<ScheduleWindowList stream={stream('2026-10-02T08:00:00Z')} section="history" opportunities={[]} onOpenOpportunity={() => {}} />)
    expect(html).toContain('01:00')
    expect(html).not.toContain('Exact time TBD')
  })
})

import { createSnapshot } from '../src/snapshot.js'
import { buildScheduleStream } from '../src/schedule/scheduleStream.js'

describe('date-only event chronology', () => {
  it('keeps declared event/completion dates in zones west of UTC', () => {
    const source = createSnapshot({ opportunities: [], processes: [], actions: [], prep: [], applicationGroups: [],
      processEvents: [{ id: 'invitation', opportunityId: 'job', company: 'Synthetic', role: 'Role', type: 'interview_invite', source: 'manual', occurredAt: '2026-10-02', createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z' }],
      timeline: [{ id: 'application', kind: 'application_submitted', category: 'opportunity', source: 'user_action', title: 'Applied', occurredAt: '2026-10-03', recordedAt: '2026-10-06T12:00:00Z' }],
      scheduleNodes: [{ id: 'completed', occurrenceId: 'completed', version: 1, kind: 'interview', state: 'completed', completedAt: '2026-10-04', constraintKind: 'employer_hard',
        temporal: { shape: 'date_only', precision: 'date', date: '2026-10-04', timezone: 'floating-date', resolutionBasis: 'source_explicit' },
        relatedActionIds: [], relatedPrepIds: [], evidenceRefs: [], sourceVersionRefs: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T12:00:00Z' }],
    }, '2026-10-06T12:00:00Z')
    const result = buildScheduleStream(source, { accountKey: 'synthetic', workspaceRevision: '1', timezone: 'America/Los_Angeles', now: new Date('2026-10-06T12:00:00Z') })
    expect(result.sections.history.map(entry => entry.date)).toEqual(['2026-10-04'])
    expect(source.data.timeline![0].occurredAt).toBe('2026-10-03')
    expect(source.data.processEvents[0].occurredAt).toBe('2026-10-02')
  })
})
