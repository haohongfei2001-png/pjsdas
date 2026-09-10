import { parseProgressUpdate as parseV3 } from './progressUpdateV3'
import type { Opportunity } from './model'

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

export function parseProgressUpdate(
  rawText: string,
  currentOpportunities: Opportunity[],
  now = new Date(),
) {
  return parseV3(
    coalesceRecruitingNotificationContinuations(rawText),
    currentOpportunities,
    now,
  )
}
