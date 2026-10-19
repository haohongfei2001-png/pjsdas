import { resolveSourceTemporal } from './sourceTemporal.js'

/** Detection is conservative, not a parser: unsupported calendar/duration
 * notation must not become an apparently untimed task. */
function containsTimeClaim(text: string) {
  return /\d{1,4}\s*(?:年|月|日|号|[:：])|\d{1,2}[./-]\d{1,2}|(?:\d+|[一二三四五六七八九十半]+)\s*(?:点|时|天|周|个月|小时|分钟)|今天|明天|后天|昨天|前天|[今明昨][早晚夜晨]|(?:本|这|下|上)(?:周|星期|个?月)|星期|周[一二三四五六日天末]|上午|下午|晚上|早上|中午|\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:this|next|last)\s+(?:week|month)\b|\b\d+\s*(?:am|pm|hours?|days?|weeks?|minutes?)\b/i.test(text)
}

/** Supported scheduling syntax: optional task label, one source date followed
 * by an optional HH:mm/H时mm clock, then a supported task verb and task text.
 * Other time claims retain their original text and require clarification. */
export function readWebPlanningTime(text: string, receivedAt: string, timezone?: string) {
  if (!containsTimeClaim(text)) return { kind: 'untimed' as const }
  if (!timezone) return { kind: 'unresolved' as const }
  const date = '(?:20\\d{2}[年/-]\\d{1,2}[月/-]\\d{1,2}日?|大后天|后天|明天|今天|(?:本|下)周[一二三四五六日天]|day after tomorrow|tomorrow|today|(?:this|next)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))'
  const clock = '(?:\\d{1,2}(?:[:：]|时)\\d{2}分?)'
  const pattern = new RegExp(`^\\s*(?:(?:事项|待办|其他事项|个人事项|非求职)\\s*[:：]\\s*)?(${date})(?:\\s*(${clock}))?\\s*((?:填写|提交|处理|准备|整理|复习|练习|修改|prepare\\b|practice\\b|revise\\b).+?)\\s*[。.!！]?\\s*$`, 'i')
  const match = pattern.exec(text)
  if (!match || containsTimeClaim(match[3]!)) return { kind: 'unresolved' as const }
  // Keep the whole-input resolver's existing zone/offset guards. A source zone
  // after the task verb must not disappear when validating the date prefix.
  const temporal = resolveSourceTemporal(text, {
    receivedAt, timezone, mode: match[2] ? 'fixed' : 'deadline',
  })
  return temporal ? { kind: 'resolved' as const, temporal } : { kind: 'unresolved' as const }
}
