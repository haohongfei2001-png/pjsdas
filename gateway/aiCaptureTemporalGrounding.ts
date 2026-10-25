import type { AiCaptureProviderOutput, AiCaptureTrustedContext } from './aiCaptureContract.js'
import type { ScheduleNodeTemporal } from '../src/model.js'
import { resolveSourceTemporal } from '../src/sourceTemporal.js'

type Candidate = AiCaptureProviderOutput['candidates'][number]
const sameInstant = (left?: string, right?: string) => left === undefined || right === undefined
  ? left === right : Date.parse(left) === Date.parse(right)
const dateExpression = /(?<!\d)20\d{2}[年\/-]\d{1,2}[月\/-]\d{1,2}日?(?!\d)|大后天|后天|明天|今天|day after tomorrow|tomorrow|today|(?:本|下)周[一二三四五六日天]|(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi
const clockExpression = /(?<!\d)\d{1,2}(?:[:：]|时)\d{2}分?(?:\s*(?:am|pm)\b)?(?!\d)/gi
const deadlineLanguage = /截止|截至|最晚|最迟|前(?:完成|提交|投递|申请)|\b(?:deadline|due|no later than|latest start|closing date|applications? close)\b|\b(?:by|before)\s+(?=20\d{2}|today|tomorrow|this\s|next\s|\d{1,2}[:：])/i
const endLanguage = /结束|\b(?:ends|finishes)\b|\b(?:end|finish)\s+(?:at|on|time|date|is)\b/i
const submittedLanguage = /已(?:经)?(?:投递|申请|提交)|(?:投递|申请|提交)(?:了|完成|成功)|\b(?:applied|submitted)\b/i
const windowLanguage = /开放|可参加|可完成|有效时间|时间窗|\b(?:availability|available|window)\b/i
const fragmentsOf = (text: string) => text.split(/[。！？!?；;，,\r\n]+|\.(?=\s|$)/).map(value => value.trim()).filter(Boolean)
const withoutTime = (text: string) => text.replace(dateExpression, '').replace(clockExpression, '')
const timeOnly = (text: string) => !withoutTime(text).replace(/时间窗|时间|日期|定于|安排在|安排于|最晚|最迟|开始|开考|入场|进入|启动|截止|截至|开放|可参加|可完成|有效|上午|下午|早上|晚上|中午|是|在|于|到|至|\b(?:time|date|is|at|on|from|to|until|between|and|window|available|availability|latest|start|deadline|due|by|am|pm)\b|[\s:：\-—–~～()（）]/gi, '').length
const normalized = (value: string) => value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

function completedApplication(text: string, candidate: Extract<Candidate, { kind: 'application_submitted' }>) {
  if (/尚未|未曾|没(?:有)?|不是|并非|不曾|未(?:投递|申请|提交)|\b(?:not|never|cannot|[a-z]+n['’]t)\b/i.test(text)) return false
  const identity = [candidate.target.company, candidate.target.role]
  return fragmentsOf(text).some(part => submittedLanguage.test(part) && (
    identity.every(name => name && normalized(part).includes(normalized(name)))
    || !part.replace(new RegExp(submittedLanguage.source, 'gi'), '').replace(/我|已经|已|了|成功|\b(?:i|have|has|had|already|successfully)\b|\s/gi, '').length))
}

function hasTemporalRole(text: string, role: RegExp) {
  const fragments = fragmentsOf(text), times = fragments.filter(part => withoutTime(part) !== part)
  if (times.some(part => role.test(part))) return true
  const qualifiers = fragments.filter(part => withoutTime(part) === part)
  return qualifiers.length === 1 && times.length > 0 && times.every(timeOnly) && role.test(qualifiers[0])
}

function attributableExpression(text: string, candidate: Candidate) {
  const fragments = fragmentsOf(text)
  if (fragments.length < 2) return true
  const identity = candidate.kind === 'user_opportunity' ? [candidate.company, candidate.role]
    : 'target' in candidate ? [candidate.target.company, candidate.target.role]
      : candidate.kind === 'manual_action' ? [candidate.title] : []
  return fragments.every(fragment => {
    const withoutTimes = withoutTime(fragment)
    if (withoutTimes === fragment) return true
    if (identity.length && identity.every(name => name && normalized(fragment).includes(normalized(name)))) return true
    // A separate time-only clause can qualify the identified event (including
    // “Interview arranged. Time is tomorrow 15:00.”), but a second activity's
    // date cannot be borrowed. Unknown residual prose needs clarification.
    return timeOnly(fragment)
  })
}

function completeExpression(text: string, value: ScheduleNodeTemporal | undefined) {
  if (!value) return false
  // The shared parser deliberately handles minute precision. Do not let a
  // successful prefix silently discard seconds or an unsupported clock form.
  if (/\d[:：]\d{2}[:：]\d{2}|\d\s*秒|\b[ap]\.\s*m\.?|(?<![\d:：])\b\d{1,2}\s*(?:am|pm)\b/i.test(text)) return false
  const dates = (source: string) => [...source.matchAll(dateExpression)].length
  const clocks = (source: string) => [...source.matchAll(clockExpression)].length
  if (dates(text) !== dates(value.rawExpression ?? '')) return false
  if (value.shape === 'availability_window') {
    // Range parsing does not resolve meridiem. Require unambiguous 24h clocks,
    // and account for every bound rather than accepting the first regex match.
    if (/\b(?:am|pm)\b|上午|下午|早上|晚上|中午/i.test(text)) return false
    return clocks(text) === 2 + (value.latestStartAt ? 1 : 0)
  }
  return clocks(text) === (value.shape === 'date_only' ? 0 : clocks(value.rawExpression ?? ''))
}

/** Validate facts, not just their formats. Reuse the reschedule/source resolver's
 * original reference time, date precision, timezone and DST ambiguity rules.
 * This is a veto, never an alternative candidate extractor or write authority.
 * Each candidate needs one unambiguous temporal expression in its own evidence;
 * unsupported expressions remain a clarification, not a guessed model time. */
export function hasGroundedAiCaptureTimes(candidate: Candidate, context: Pick<AiCaptureTrustedContext, 'referenceTime' | 'timezone'>) {
  // Reschedules have their own original/replacement spans AND whole-notice proof.
  if (candidate.kind === 'occurrence_rescheduled') return true
  // URL paths/query parameters are not statements of a date or time, and must
  // not be mistaken for source timezone names by the shared resolver either.
  const source = candidate.evidence.quote.replace(/https?:\/\/[^\s<>"'“”‘’]+/g, ' ')
  // Completed-submission evidence is mandatory even when the optional timestamp
  // is omitted: downstream receipt timestamps must not manufacture completion.
  if (candidate.kind === 'application_submitted' && !completedApplication(source, candidate)) return false
  const historicalFact = candidate.kind === 'application_submitted'
    || candidate.kind === 'process_event' && !candidate.eventType.endsWith('_invite')
  const mentionsTime = withoutTime(source) !== source || /\d[点點]|昨天|前天|上周|上个月|\byesterday\b|\blast\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(source)
  if (historicalFact && !candidate.occurredAt && mentionsTime) return false
  if (!['plannedDate', 'scheduledTemporal', 'temporal', 'occurredAt', 'deadline'].some(key => key in candidate)) return true
  // These source-relative or explicitly zoned expressions require information
  // that a web capture's referenceTime/user timezone cannot supply. Never treat
  // the capture timestamp as an original email receipt or named source zone.
  if (/(?:收到|接收).*?(?:邮件|电子邮件).*?\d+\s*(?:小时|天|日)|\b(?:receipt|received|receiving)\b.*\b(?:mail|email)\b.*\d+\s*(?:hours?|days?)\b|\d+\s*(?:hours?|days?)\b.*\b(?:receipt|received|receiving)\b.*\b(?:mail|email)\b/i.test(source)) return false
  if (/(?:北京|上海|香港|台北|东京|首尔|新加坡|纽约|洛杉矶|悉尼|墨尔本|巴黎|柏林|中国|日本|韩国|美国|英国|欧洲|澳大利亚)(?:标准|夏令|当地)?时间|标准时间|夏令时间|当地时间|本地时间|时区|\b(?:standard|daylight|local)\s+time(?![a-z])/i.test(source)) return false
  if (/或|或者|大概|大约|左右|\b(?:or|approximately|about|around)\b/i.test(source)) return false
  // Numeric Chinese hour notation states minute zero (or 半 / explicit minutes),
  // not an estimated duration. Normalize it before using the shared resolver.
  if (/[点點](?:[零〇一二三四五六七八九十两百刻过差])|差.*?(?:分|刻)/.test(source)) return false
  const text = source.replace(/(?<!\d)(\d{1,2})[点點](?:(半)|(\d{1,2})分?)?/g,
    (_match, hour: string, half: string | undefined, minute: string | undefined) => `${hour}:${half ? '30' : (minute ?? '00').padStart(2, '0')}`)
  if (!attributableExpression(text, candidate)) return false
  const options = { receivedAt: context.referenceTime, timezone: context.timezone }
  const resolve = (mode: 'fixed' | 'deadline') => {
    const value = resolveSourceTemporal(text, { ...options, mode })
    return completeExpression(text, value) ? value : undefined
  }
  const fixed = resolve('fixed'), deadline = resolve('deadline')
  const hasDeadlineRole = hasTemporalRole(text, deadlineLanguage)
  const statedDate = (value: string) => deadline?.shape === 'date_only' && deadline.date === value
  const statedInstant = (value: string) => !hasDeadlineRole && Date.parse(value) <= Date.parse(context.referenceTime)
    && fixed?.shape === 'fixed_range' && sameInstant(fixed.startAt, value)
  const statedDeadline = (value: string, precision: 'date' | 'datetime') => hasDeadlineRole && (precision === 'date'
    ? statedDate(value) : deadline?.shape === 'deadline' && sameInstant(deadline.deadlineAt, value))
  const statedTemporal = (value: Omit<ScheduleNodeTemporal, 'resolutionBasis'>) => {
    if (value.timezone !== context.timezone) return false
    if (value.shape === 'date_only') return Boolean(value.date && statedDate(value.date))
    if (value.shape === 'deadline') return Boolean(value.deadlineAt && statedDeadline(value.deadlineAt, 'datetime'))
    if (value.shape === 'fixed_range') {
      if (hasDeadlineRole || !value.endAt && hasTemporalRole(text, endLanguage)) return false
      // The shared source parser represents an explicit pair of clock bounds as
      // a window. It also grounds a fixed appointment's explicitly stated end,
      // but cannot turn an employer latest-start constraint into an appointment.
      return (fixed?.shape === 'fixed_range' || fixed?.shape === 'availability_window' && !fixed.latestStartAt)
        && sameInstant(fixed.startAt, value.startAt) && sameInstant(fixed.endAt, value.endAt)
    }
    return value.shape === 'availability_window' && fixed?.shape === 'availability_window' && hasTemporalRole(text, windowLanguage)
      && sameInstant(fixed.startAt, value.startAt) && sameInstant(fixed.endAt, value.endAt)
      && sameInstant(fixed.latestStartAt, value.latestStartAt)
  }
  if ('plannedDate' in candidate && candidate.plannedDate && (hasDeadlineRole || !statedDate(candidate.plannedDate))) return false
  if ('scheduledTemporal' in candidate && candidate.scheduledTemporal && !statedTemporal(candidate.scheduledTemporal)) return false
  if ('temporal' in candidate && candidate.temporal && !statedTemporal(candidate.temporal)) return false
  if (candidate.kind === 'process_event' && candidate.temporal?.shape === 'date_only'
    && (candidate.timingMode === 'fixed' && hasDeadlineRole
      || candidate.timingMode === 'deadline' && !hasDeadlineRole)) return false
  // A timestamp on an invitation/deadline is not evidence that an application
  // was submitted. Occurred-at remains a past factual timestamp, never a plan.
  if (candidate.kind === 'application_submitted' && candidate.occurredAt
    && !hasTemporalRole(text, submittedLanguage)) return false
  if ('occurredAt' in candidate && candidate.occurredAt && !statedInstant(candidate.occurredAt)) return false
  if (candidate.kind === 'opportunity_deadline' && !statedDeadline(candidate.deadline, candidate.precision)) return false
  if (candidate.kind === 'user_opportunity' && candidate.deadline
    && !statedDeadline(candidate.deadline, candidate.deadlinePrecision ?? (/^\d{4}-\d{2}-\d{2}$/.test(candidate.deadline) ? 'date' : 'datetime'))) return false
  return true
}
