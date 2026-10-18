import { normalizedUserJobFacts, type UserJobFacts } from './opportunityCreation.js'

/** This adapter selects already supplied data, never a fetch or instructions.
 * A recognized but unsupported import stays unresolved instead of falling
 * through to personal-action/progress interpretation. */
export function readExplicitStructuredQuotedJob(text: string): { facts?: UserJobFacts } | undefined {
  const lines = text.trim().split(/\r?\n/)
  const outer = lines.shift()?.trim() ?? ''
  if (!/^请(?:帮我)?(?:导入|保存|记录)(?:以下|下面)(?:的)?(?:引用的)?岗位说明[。！!：:]?$/.test(outer)) return undefined
  if (text.length > 4096 || lines.length > 12) return {}

  const fields = new Map<string, string>()
  for (const line of lines) {
    if (!line.trim()) continue
    // Every data line must belong to this single quoted block. Unquoted tails,
    // nested quotes and extra metadata cannot silently alter or lose meaning.
    const field = /^\s*>[ \t]?(公司|岗位|地点|招聘链接|申请截止)[ \t]*[:：][ \t]*(.+?)\s*$/.exec(line)
    if (!field || fields.has(field[1]!) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(field[2]!)) return {}
    const value = field[2]!.trim()
    if (!value) return {}
    fields.set(field[1]!, value)
  }
  if (!fields.get('公司') || !fields.get('岗位')) return {}
  // Reuse the same validation/normalization as the existing manual add-job
  // adapter. No source-provided actor, operation, score or authority is copied.
  try {
    return { facts: normalizedUserJobFacts({ company: fields.get('公司')!, role: fields.get('岗位')!,
      location: fields.get('地点'), sourceUrl: fields.get('招聘链接'), deadline: fields.get('申请截止') }) }
  } catch { return {} }
}
