import { parseProgressUpdate as parseV3 } from './progressUpdateV3'
import { parseRecruitingNotification } from './notificationParser'
import type { Opportunity } from './model'
import type {
  ExecutableProgressOperation,
  IgnoredOperation,
  ProgressOperation,
  UnresolvedOperation,
} from './progressUpdateV3'

export * from './progressUpdateV3'

/**
 * Recruiter messages often put the event in one sentence and the expiry in the
 * next one, e.g. “邀请参加在线测评。作答链接将在…失效”。 The timeline parser
 * normally treats punctuation as event boundaries, so merge only obvious
 * deadline-continuation sentences before structural parsing.
 */
export function coalesceRecruitingNotificationContinuations(rawText: string) {
  return rawText.replace(
    /[。；;]\s*(?=(?:(?:作答|测评|笔试|考试|在线)?(?:链接|入口|页面|系统))[^。；;\n]{0,120}(?:失效|截止|有效期|关闭))/g,
    '，',
  )
}

function hasExplicitCalendarDate(text: string) {
  return /(?:(?:20\d{2})\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]/.test(text) ||
    /20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text)
}

function temporaryOpportunity(operation: Extract<ProgressOperation, { kind: 'process_event' }>): Opportunity {
  return {
    id: operation.opportunityId,
    company: operation.company,
    role: operation.role,
    currentStageLabel: '流程中',
    processStage: 'screening',
    roleType: 'core',
    early: false,
    opportunityValue: 80,
    fitScore: 60,
    importedAt: operation.occurredAt,
  }
}

function repairExplicitCalendarMetadata(
  operation: ProgressOperation,
  opportunities: Opportunity[],
): ProgressOperation {
  if (operation.kind !== 'process_event' || !hasExplicitCalendarDate(operation.sourceText)) return operation

  const target = opportunities.find((item) => item.id === operation.opportunityId)
    ?? temporaryOpportunity(operation)
  const parsed = parseRecruitingNotification(
    operation.sourceText,
    [target],
    new Date(operation.occurredAt),
  )

  if (!parsed.dueAt) return operation
  return {
    ...operation,
    dueAt: parsed.dueAt,
    timingMode: parsed.timingMode ?? operation.timingMode,
    estimatedMinutes: parsed.estimatedMinutes ?? operation.estimatedMinutes,
  }
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
) {
  const base = parseV3(
    coalesceRecruitingNotificationContinuations(rawText),
    currentOpportunities,
    now,
  )
  const operations = base.operations.map((item) =>
    repairExplicitCalendarMetadata(item, currentOpportunities),
  )
  const unresolved = operations.filter(
    (item): item is UnresolvedOperation => item.kind === 'unresolved',
  )
  const ignored = operations.filter(
    (item): item is IgnoredOperation => item.kind === 'ignored',
  )
  const executable = operations.filter(
    (item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored',
  )

  return { operations, executable, unresolved, ignored }
}
