import {
  parseProgressUpdate as parseProgressUpdateV4,
  type ExecutableProgressOperation,
  type ProgressOperation,
  type ProgressUpdatePlan,
  type UnresolvedOperation,
} from './progressUpdateV4.js'
import { detectNotificationType, matchNotificationOpportunity } from './notificationParser.js'
import {
  defaultMinutesForProcessEvent,
  defaultTimingModeForProcessEvent,
  isActionableProcessEvent,
  stageForProcessEvent,
} from './processEvents.js'
import type { Opportunity, ProcessEventType } from './model.js'

export * from './progressUpdateV4.js'

const PROCESS_TASK = '(?:测评|笔试|面试|考试)'

function explicitProcessCompletion(text: string) {
  if (!new RegExp(PROCESS_TASK, 'i').test(text)) return false

  // Do not mistake an instruction/deadline containing “完成” for a report that
  // the user has actually finished the task.
  const pendingInstruction = new RegExp(
    `(?:请|需|需要|须|务必|应当|待).{0,16}(?:完成|做完|参加).{0,10}${PROCESS_TASK}|(?:截止|最晚|(?:小时|天|日)内|前).{0,16}(?:完成|做完)`,
    'i',
  )
  const strongCompletion = new RegExp(
    `(?:已(?:经)?|刚刚?|刚).{0,6}(?:完成|做完|考完|面完|参加完)(?:了)?.{0,8}${PROCESS_TASK}|${PROCESS_TASK}.{0,6}(?:已(?:经)?)?(?:完成(?:了)?|做完(?:了)?|结束(?:了)?|完毕|考完(?:了)?|面完(?:了)?)|(?:完成了|做完了|考完了|面完了|参加完了).{0,8}${PROCESS_TASK}`,
    'i',
  )

  if (strongCompletion.test(text)) return true
  if (pendingInstruction.test(text)) return false

  // “测评完成 / 笔试结束” are concise status statements; unlike
  // “48 小时内完成测评”, the task noun appears first with no instruction cue.
  return new RegExp(`${PROCESS_TASK}\s*(?:完成|结束)$`, 'i').test(text.trim())
}

function targetForExplicitCompletion(
  operation: UnresolvedOperation,
  currentOpportunities: Opportunity[],
  type: ProcessEventType,
) {
  const direct = matchNotificationOpportunity(operation.sourceText, currentOpportunities)
  if (direct.selected) return direct.selected

  const candidateIds = new Set(operation.candidates?.map((item) => item.id) ?? [])
  const candidates = candidateIds.size
    ? currentOpportunities.filter((item) => candidateIds.has(item.id))
    : []
  if (candidates.length === 1) return candidates[0]

  const desiredStage = stageForProcessEvent(type)
  if (desiredStage) {
    const stageMatches = candidates.filter((item) => item.processStage === desiredStage)
    if (stageMatches.length === 1) return stageMatches[0]
  }
  return undefined
}

function completedEventFromUnresolved(
  operation: UnresolvedOperation,
  currentOpportunities: Opportunity[],
): ExecutableProgressOperation | undefined {
  if (!explicitProcessCompletion(operation.sourceText)) return undefined
  const detected = detectNotificationType(operation.sourceText)
  if (!detected.type || !isActionableProcessEvent(detected.type)) return undefined
  const target = targetForExplicitCompletion(operation, currentOpportunities, detected.type)
  if (!target) return undefined

  return {
    id: `completed:${operation.id}`,
    kind: 'process_event',
    sourceText: operation.sourceText,
    confidence: 'high',
    occurredAt: operation.occurredAt,
    opportunityId: target.id,
    company: target.company,
    role: target.role,
    eventType: detected.type,
    timingMode: defaultTimingModeForProcessEvent(detected.type),
    estimatedMinutes: defaultMinutesForProcessEvent(detected.type),
    completed: true,
  }
}

function repairExplicitCompletions(
  plan: ProgressUpdatePlan,
  currentOpportunities: Opportunity[],
): ProgressUpdatePlan {
  const operations: ProgressOperation[] = plan.operations.map((operation) => {
    if (operation.kind === 'process_event' &&
      isActionableProcessEvent(operation.eventType) &&
      explicitProcessCompletion(operation.sourceText)) {
      return { ...operation, completed: true, confidence: 'high' }
    }
    if (operation.kind === 'unresolved') {
      return completedEventFromUnresolved(operation, currentOpportunities) ?? operation
    }
    return operation
  })

  const unique = [...new Map(operations.map((item) => [item.id, item])).values()]
  return {
    operations: unique,
    executable: unique.filter(
      (item): item is ExecutableProgressOperation => item.kind !== 'unresolved' && item.kind !== 'ignored',
    ),
    unresolved: unique.filter((item): item is UnresolvedOperation => item.kind === 'unresolved'),
    ignored: unique.filter((item): item is Extract<ProgressOperation, { kind: 'ignored' }> => item.kind === 'ignored'),
  }
}

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
): ProgressUpdatePlan {
  return repairExplicitCompletions(
    parseProgressUpdateV4(rawText, currentOpportunities, now),
    currentOpportunities,
  )
}
