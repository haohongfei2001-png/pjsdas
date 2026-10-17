import { discoveryScopeSchema, type DiscoveryScopeInput } from './discoveryScopeSchema.js'

const unique = (items: string[]) => [...new Set(items.map(item => item.trim()).filter(Boolean))]
/** Bounded rule interpretation only; proposals never persist or start automation. */
export function proposeSearchScope(text: string, previous?: DiscoveryScopeInput): DiscoveryScopeInput {
  const input = text.trim()
  if (!input || input.length > 2400) throw new Error('请输入简短、明确的岗位目标。 / Enter a short, explicit job goal.')
  const base: DiscoveryScopeInput = previous ? structuredClone(previous) : { searchGoal: input, targetRoleQueries: [], preferredLocations: [], mustHave: [], mustNotHave: [], titleIncludes: [], titleExcludes: [] }
  if (previous && input === '只要纯产品经理') return discoveryScopeSchema.parse({ ...base, targetRoleQueries: ['产品经理'], titleEquals: ['产品经理'], titleIncludes: [], titleExcludes: unique([...(base.titleExcludes ?? []), 'AI 产品经理', '产品运营']) })
  const exact = previous && /^(?:完整标题|exact title)\s*[:：]\s*(.+)$/i.exec(input)
  if (exact) return discoveryScopeSchema.parse({ ...base, titleEquals: unique(exact[1].split(/[、,，]/)) })
  const exclusion = /^(?:不要|排除|exclude\s+|no\s+)(.+)$/i.exec(input)
  if (previous && exclusion) return discoveryScopeSchema.parse({ ...base, titleExcludes: unique([...(base.titleExcludes ?? []), exclusion[1]]) })
  if (previous && /^(?:更广一些|更广一点|broader)$/i.test(input)) {
    if (!base.targetRoleQueries.some(value => value === '产品经理')) throw new Error('请直接说明想增加的岗位词。 / Specify the additional job titles.')
    return discoveryScopeSchema.parse({ ...base, targetRoleQueries: unique([...base.targetRoleQueries, 'AI 产品经理', 'AI 应用产品经理']) })
  }
  const add = previous && /^(?:增加|加入|add\s+)(.+)$/i.exec(input)
  if (add) return discoveryScopeSchema.parse({ ...base, targetRoleQueries: unique([...base.targetRoleQueries, ...add[1].split(/[、,，\n]/)]) })
  const location = previous && /^(?:地点|城市|location)\s*[:：]\s*(.+)$/i.exec(input)
  if (location) return discoveryScopeSchema.parse({ ...base, preferredLocations: unique(location[1].split(/[、,，\n]/)), locationPolicy: 'strict' })
  if (previous) throw new Error('请使用“增加岗位词”“不要岗位词”或“地点：城市”，或直接编辑下方准则。 / Use “add title”, “exclude title” or “location: city”, or edit the criteria directly.')
  // Do not silently flatten a sentence containing constraints into retrieval terms.
  if (/[。；;!?？]|不要|排除|薪资|以上|以下|只要|在.+(?:找|工作)|\b(?:except|only|salary|in)\b/i.test(input)) throw new Error('请先输入岗位名称，再在准则中明确地点和排除条件。 / Start with job titles, then specify locations and exclusions in the criteria.')
  return discoveryScopeSchema.parse({ ...base, targetRoleQueries: unique(input.split(/[、,，\n]/)) })
}
