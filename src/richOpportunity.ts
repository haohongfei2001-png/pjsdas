import type {
  Opportunity,
  OpportunityFactUnknownField,
  OpportunityFacts,
} from './model.js'

export const OPPORTUNITY_FACT_FIELDS: OpportunityFactUnknownField[] = [
  'department',
  'business_unit',
  'locations',
  'recruitment_batch',
  'responsibilities',
  'requirements',
  'education',
  'majors',
  'experience',
  'skills',
  'languages',
  'application_method',
  'deadline',
  'compensation',
]

export interface RichOpportunityFactsInput {
  department?: string
  businessUnit?: string
  locations?: string[]
  recruitmentBatch?: string
  responsibilities?: string[]
  requirements?: string[]
  educationRequirement?: string
  majorRequirements?: string[]
  experienceRequirement?: string
  skills?: string[]
  languageRequirements?: string[]
  applicationMethod?: string
  applicationUrl?: string
  annualCompensationMaxWan?: number
  compensationBasis?: string
  evidenceSummary?: string
}

export interface CreateOpportunityFactsInput {
  sourceUrl: string
  sourceTitle: string
  verifiedAt: string
  location?: string
  deadline?: string
  compensationText?: string
  annualCompensationMinWan?: number
  facts?: RichOpportunityFactsInput
}

function cleanText(value: string | undefined, max = 500) {
  const cleaned = value?.trim().replace(/\s+/g, ' ')
  return cleaned ? cleaned.slice(0, max) : undefined
}

function cleanList(values: string[] | undefined, maxItems: number, maxLength = 320) {
  if (!values?.length) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = cleanText(raw, maxLength)
    if (!value) continue
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= maxItems) break
  }
  return result.length ? result : undefined
}

function isPublicHttpUrl(value: string | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLocaleLowerCase()
    return Boolean(host && host !== 'localhost' && host !== '0.0.0.0' && host !== '::1' && !host.startsWith('127.'))
  } catch {
    return false
  }
}

function unknownFieldsFor(facts: Omit<OpportunityFacts, 'unknownFields'>) {
  const unknown: OpportunityFactUnknownField[] = []
  if (!facts.identity.department) unknown.push('department')
  if (!facts.identity.businessUnit) unknown.push('business_unit')
  if (!facts.identity.locations?.length) unknown.push('locations')
  if (!facts.identity.recruitmentBatch && !facts.application.recruitmentBatch) unknown.push('recruitment_batch')
  if (!facts.role.responsibilities?.length) unknown.push('responsibilities')
  if (!facts.role.requirements?.length) unknown.push('requirements')
  if (!facts.role.educationRequirement) unknown.push('education')
  if (!facts.role.majorRequirements?.length) unknown.push('majors')
  if (!facts.role.experienceRequirement) unknown.push('experience')
  if (!facts.role.skills?.length) unknown.push('skills')
  if (!facts.role.languageRequirements?.length) unknown.push('languages')
  if (!facts.application.applicationMethod) unknown.push('application_method')
  if (!facts.application.deadline) unknown.push('deadline')
  if (facts.compensation.annualMinWan === undefined && facts.compensation.annualMaxWan === undefined) unknown.push('compensation')
  return unknown
}

export function createOpportunityFacts(input: CreateOpportunityFactsInput): OpportunityFacts {
  const extra = input.facts ?? {}
  const locations = cleanList([
    ...(input.location ? [input.location] : []),
    ...(extra.locations ?? []),
  ], 10, 120)
  const recruitmentBatch = cleanText(extra.recruitmentBatch, 160)
  const base: Omit<OpportunityFacts, 'unknownFields'> = {
    version: 1,
    identity: {
      department: cleanText(extra.department, 200),
      businessUnit: cleanText(extra.businessUnit, 200),
      locations,
      recruitmentBatch,
    },
    role: {
      responsibilities: cleanList(extra.responsibilities, 12),
      requirements: cleanList(extra.requirements, 16),
      educationRequirement: cleanText(extra.educationRequirement, 300),
      majorRequirements: cleanList(extra.majorRequirements, 12, 200),
      experienceRequirement: cleanText(extra.experienceRequirement, 300),
      skills: cleanList(extra.skills, 16, 160),
      languageRequirements: cleanList(extra.languageRequirements, 8, 180),
    },
    application: {
      applicationUrl: isPublicHttpUrl(extra.applicationUrl) ? extra.applicationUrl : undefined,
      applicationMethod: cleanText(extra.applicationMethod, 300),
      deadline: input.deadline,
      recruitmentBatch,
    },
    compensation: {
      raw: cleanText(input.compensationText, 500),
      annualMinWan: input.annualCompensationMinWan,
      annualMaxWan: extra.annualCompensationMaxWan,
      basis: cleanText(extra.compensationBasis, 300),
    },
    evidence: {
      sourceUrl: input.sourceUrl,
      sourceTitle: cleanText(input.sourceTitle, 300) ?? input.sourceTitle,
      verifiedAt: input.verifiedAt,
      evidenceSummary: cleanText(extra.evidenceSummary, 1200),
    },
  }
  return { ...base, unknownFields: unknownFieldsFor(base) }
}

function equalStringArrays(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function validateOptionalText(value: string | undefined, label: string, maxLength: number, errors: string[]) {
  if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > maxLength)) {
    errors.push(`Rich Opportunity ${label} 无效。`)
  }
}

function validateList(values: string[] | undefined, label: string, maxItems: number, maxLength: number, errors: string[]) {
  if (values === undefined) return
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems || values.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength)) {
    errors.push(`Rich Opportunity ${label} 无效。`)
  }
}

export function validateOpportunityFacts(facts: OpportunityFacts): string[] {
  const errors: string[] = []
  if (facts.version !== 1) errors.push('Rich Opportunity facts version 必须为 1。')
  if (!isPublicHttpUrl(facts.evidence?.sourceUrl)) errors.push('Rich Opportunity 来源 URL 无效。')
  if (!facts.evidence?.sourceTitle?.trim() || facts.evidence.sourceTitle.length > 300) errors.push('Rich Opportunity 来源标题无效。')
  if (!facts.evidence?.verifiedAt || Number.isNaN(new Date(facts.evidence.verifiedAt).getTime())) errors.push('Rich Opportunity verifiedAt 无效。')
  validateOptionalText(facts.evidence.evidenceSummary, 'evidenceSummary', 1200, errors)
  if (facts.application.applicationUrl !== undefined && !isPublicHttpUrl(facts.application.applicationUrl)) errors.push('Rich Opportunity 投递 URL 无效。')
  if (facts.application.deadline !== undefined && Number.isNaN(new Date(facts.application.deadline).getTime())) errors.push('Rich Opportunity 截止时间无效。')
  validateOptionalText(facts.identity.department, 'department', 200, errors)
  validateOptionalText(facts.identity.businessUnit, 'businessUnit', 200, errors)
  validateOptionalText(facts.identity.recruitmentBatch, 'recruitmentBatch', 160, errors)
  validateOptionalText(facts.application.recruitmentBatch, 'application.recruitmentBatch', 160, errors)
  validateOptionalText(facts.role.educationRequirement, 'educationRequirement', 300, errors)
  validateOptionalText(facts.role.experienceRequirement, 'experienceRequirement', 300, errors)
  validateOptionalText(facts.application.applicationMethod, 'applicationMethod', 300, errors)
  validateOptionalText(facts.compensation.raw, 'compensation.raw', 500, errors)
  validateOptionalText(facts.compensation.basis, 'compensation.basis', 300, errors)
  validateList(facts.identity.locations, 'locations', 10, 120, errors)
  validateList(facts.role.responsibilities, 'responsibilities', 12, 320, errors)
  validateList(facts.role.requirements, 'requirements', 16, 320, errors)
  validateList(facts.role.majorRequirements, 'majorRequirements', 12, 200, errors)
  validateList(facts.role.skills, 'skills', 16, 160, errors)
  validateList(facts.role.languageRequirements, 'languageRequirements', 8, 180, errors)
  for (const value of [facts.compensation.annualMinWan, facts.compensation.annualMaxWan]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1000)) errors.push('Rich Opportunity 薪资区间无效。')
  }
  if (facts.compensation.annualMinWan !== undefined && facts.compensation.annualMaxWan !== undefined && facts.compensation.annualMinWan > facts.compensation.annualMaxWan) {
    errors.push('Rich Opportunity 最低年薪不能高于最高年薪。')
  }
  const allowed = new Set(OPPORTUNITY_FACT_FIELDS)
  if (!Array.isArray(facts.unknownFields) || facts.unknownFields.some((item) => !allowed.has(item))) errors.push('Rich Opportunity unknownFields 无效。')
  else {
    const expected = unknownFieldsFor({ ...facts, unknownFields: undefined } as unknown as Omit<OpportunityFacts, 'unknownFields'>)
    if (!equalStringArrays(facts.unknownFields, expected)) errors.push('Rich Opportunity unknownFields 与已知事实不一致。')
  }
  return errors
}

export function opportunityFactsCompleteness(facts: OpportunityFacts | undefined) {
  const total = OPPORTUNITY_FACT_FIELDS.length
  if (!facts) return { known: 0, total, percent: 0 }
  const unknown = new Set(facts.unknownFields)
  const known = OPPORTUNITY_FACT_FIELDS.filter((item) => !unknown.has(item)).length
  return { known, total, percent: Math.round((known / total) * 100) }
}

function mergeList(a: string[] | undefined, b: string[] | undefined, max: number) {
  return cleanList([...(b ?? []), ...(a ?? [])], max)
}

export function mergeOpportunityFacts(previous: OpportunityFacts | undefined, incoming: OpportunityFacts | undefined) {
  if (!previous) return incoming
  if (!incoming) return previous
  return createOpportunityFacts({
    sourceUrl: incoming.evidence.sourceUrl,
    sourceTitle: incoming.evidence.sourceTitle,
    verifiedAt: incoming.evidence.verifiedAt >= previous.evidence.verifiedAt ? incoming.evidence.verifiedAt : previous.evidence.verifiedAt,
    location: incoming.identity.locations?.[0] ?? previous.identity.locations?.[0],
    deadline: incoming.application.deadline ?? previous.application.deadline,
    compensationText: incoming.compensation.raw ?? previous.compensation.raw,
    annualCompensationMinWan: incoming.compensation.annualMinWan ?? previous.compensation.annualMinWan,
    facts: {
      department: incoming.identity.department ?? previous.identity.department,
      businessUnit: incoming.identity.businessUnit ?? previous.identity.businessUnit,
      locations: mergeList(previous.identity.locations, incoming.identity.locations, 10),
      recruitmentBatch: incoming.identity.recruitmentBatch ?? incoming.application.recruitmentBatch ?? previous.identity.recruitmentBatch ?? previous.application.recruitmentBatch,
      responsibilities: mergeList(previous.role.responsibilities, incoming.role.responsibilities, 12),
      requirements: mergeList(previous.role.requirements, incoming.role.requirements, 16),
      educationRequirement: incoming.role.educationRequirement ?? previous.role.educationRequirement,
      majorRequirements: mergeList(previous.role.majorRequirements, incoming.role.majorRequirements, 12),
      experienceRequirement: incoming.role.experienceRequirement ?? previous.role.experienceRequirement,
      skills: mergeList(previous.role.skills, incoming.role.skills, 16),
      languageRequirements: mergeList(previous.role.languageRequirements, incoming.role.languageRequirements, 8),
      applicationMethod: incoming.application.applicationMethod ?? previous.application.applicationMethod,
      applicationUrl: incoming.application.applicationUrl ?? previous.application.applicationUrl,
      annualCompensationMaxWan: incoming.compensation.annualMaxWan ?? previous.compensation.annualMaxWan,
      compensationBasis: incoming.compensation.basis ?? previous.compensation.basis,
      evidenceSummary: incoming.evidence.evidenceSummary ?? previous.evidence.evidenceSummary,
    },
  })
}

export function cloneOpportunityFacts(facts: OpportunityFacts | undefined) {
  return facts ? structuredClone(facts) : undefined
}

export function opportunityRichFacts(opportunity: Opportunity) {
  return opportunity.detail?.facts
}
