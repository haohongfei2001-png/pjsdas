import { resolveSourceTemporal } from './sourceTemporal.js'
import type { ProcessEventType, ScheduleNodeKind } from './model.js'

function removeKnownHeader(text: string, identities: Array<{ company: string; role: string }>) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const identity of [...identities].sort((a, b) => b.company.length + b.role.length - a.company.length - a.role.length)) {
    const header = new RegExp(`^\\s*${escape(identity.company)}(?:\\s+|[“"])${escape(identity.role)}[”"]?\\s*`)
    if (header.test(text)) return text.replace(header, '')
  }
  return undefined
}

/** Completion is a past fact, not merely a sentence containing 完成. Keep the
 * accepted evidence finite so obligations, conditions and unknown qualifiers
 * cannot be stripped by a short-distance keyword heuristic. */
export function completedWebRecruitingKind(text: string, identities: Array<{ company: string; role: string }>): ScheduleNodeKind | undefined {
  // Strip only an anchored known identity, never matching words elsewhere in
  // the sentence (a company/title can itself equal a qualifier such as 未).
  const evidence = removeKnownHeader(text, identities) ?? text
  const compact = evidence.replace(/[\s，,。.;；！!“”"']/g, '').replace(/^[:：]/, '')
  if (!/(?:已经|此前已|已(?:于|在|完成|结束)|刚(?:刚)?|(?:完成|结束|面完|做完|考完)了|完毕)/.test(compact)) return undefined
  const marker = '(?:已经|此前已|已|刚刚|刚)'
  const day = '20\\d{2}[年\\/-]\\d{1,2}[月\\/-]\\d{1,2}日?'
  const datedBound = `已(?:于|在)${day}(?:\\d{1,2}[：:]\\d{2})?(?:之前|前)`
  const kinds: Array<[ScheduleNodeKind, string, string, string?]> = [
    ['interview', '(?:面试|一面|二面|三面|终面|AI面|业务面|HR面)', '(?:完成|结束|面完|完毕)', '面完'],
    ['written_test', '(?:笔试|考试)', '(?:完成|结束|做完|考完|完毕)', '考完'],
    ['assessment', '(?:测评|在线测试|性格测试)', '(?:完成|结束|做完|完毕)'],
  ]
  for (const [kind, eventName, predicate, shorthand] of kinds) {
    // A demonstrative selects the current occurrence; it does not weaken the
    // required past marker, completion predicate, or full-sentence anchoring.
    const event = `(?:这次)?${eventName}`
    const forms = [
      `${marker}?${event}${marker}?${predicate}了?`,
      `${marker}?${predicate}了?${event}了?`,
      `${datedBound}${predicate}了?${event}了?`,
      `${event}${datedBound}${predicate}了?`,
      ...(shorthand ? [`${marker}?${shorthand}了?`] : []),
    ]
    if (!new RegExp(`^(?:${forms.join('|')})$`, 'i').test(compact)) continue
    const bound = /(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})日?(?:(\d{1,2})[：:](\d{2}))?/.exec(compact)
    if (bound) {
      const date = `${bound[1]}-${bound[2]!.padStart(2, '0')}-${bound[3]!.padStart(2, '0')}`
      const check = new Date(`${date}T00:00:00Z`)
      if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date
        || bound[4] && (Number(bound[4]) > 23 || Number(bound[5]) > 59)) return undefined
    }
    return kind
  }
  return undefined
}

/** A bounded Web adapter, not a general date parser. Every source token must be
 * represented or belong to this explicit neutral grammar; unknown qualifiers
 * (including source zones) cannot disappear into the configured timezone. */
export function resolveWebRecruitingTime(text: string, context: {
  company: string
  role: string
  eventType: ProcessEventType
  timezone?: string
  receivedAt: string
  mode?: 'fixed' | 'deadline'
}) {
  if (!context.timezone || !['interview_invite', 'written_test_invite', 'assessment_invite'].includes(context.eventType)) return undefined
  const evidence = removeKnownHeader(text, [context])
  if (evidence === undefined) return undefined
  const meridiems = evidence.match(/上午|下午|(?:am|pm)\b/gi) ?? []
  if (meridiems.length > 1 || /晚上|早上|中午/.test(evidence)) return undefined
  const temporal = resolveSourceTemporal(evidence, { receivedAt: context.receivedAt, timezone: context.timezone, mode: context.mode })
  if (!temporal || temporal.latestStartAt || temporal.shape === 'availability_window'
    || meridiems.length > 0 && temporal.precision !== 'datetime') return undefined
  const fullDate = /20\d{2}[年\/-]\d{1,2}[月\/-]\d{1,2}日?/
  const relativeDate = /大后天|后天|明天|今天|day after tomorrow|tomorrow|today|(?:本|下)周[一二三四五六日天]|(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i
  const remainder = evidence
    .replace(fullDate, '')
    .replace(relativeDate, '')
    .replace(/\d{1,2}(?:[:：]|时)\d{2}分?\s*(?:am|pm)?/i, '')
    .replace(/请于|请在|须在|需在|必须在|需要在|定于|安排于|安排在|时间为|开始时间|面试时间|笔试时间|测评时间|时间|参加|视频|线上|在线|面试|笔试|测评|通知|邀请|收到|上午|下午/g, '')
    .replace(context.mode === 'deadline' ? /截止|之前|前|完成/g : /$^/g, '')
    .replace(/[\s，,。.;；：:！!]/g, '')
  return remainder ? undefined : temporal
}
