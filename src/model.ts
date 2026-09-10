export type OpportunityRole = 'core' | 'backup' | 'reach' | 'lottery' | 'practice'
export type ProcessStage =
  | 'not_applied'
  | 'screening'
  | 'assessment'
  | 'written_test'
  | 'interview'
  | 'offer'
  | 'waiting_release'
  | 'closed'

export type ActionKind = 'apply' | 'follow_up' | 'prep' | 'manual'
export type ActionStatus = 'todo' | 'doing' | 'done' | 'skipped'
export type PriorityLevel = 'P0' | 'P1' | 'P2' | 'expired' | 'none'

export interface OpportunityDetail {
  backgroundTag?: string
  coreOutput?: string
  workMode?: string
  candidateProfile?: string
  jdSummary?: string
  gap?: string
  salaryMinWan?: number
  salaryMaxWan?: number
  salaryConfidence?: string
  salaryBasis?: string
  salaryRaw?: string
  intensity?: string
  windowType?: string
  earlyReason?: string
  rules?: string
}

export interface Opportunity {
  id: string
  company: string
  role: string
  currentStageLabel: string
  processStage: ProcessStage
  roleType: OpportunityRole
  early: boolean
  deadline?: string
  sourcePriority?: string
  offerProbability?: string
  salaryReference?: string
  nextActionLabel?: string
  prepEstimateMinutes?: number
  applicationGroupId?: string
  capacityStatus?: string
  order?: number
  opportunityValue: number
  fitScore: number
  detail?: OpportunityDetail
  importedAt: string
}

export interface ProcessRecord {
  id: string
  opportunityId?: string
  company: string
  role: string
  stage: ProcessStage
  stageLabel: string
  lastProgressAt?: string
  reviewThresholdDays?: number
  nextCheckAt?: string
  silenceRisk?: string
  currentAction?: string
  prepPack?: string
  notes?: string
}

export interface Action {
  id: string
  kind: ActionKind
  title: string
  opportunityId?: string
  prepId?: string
  dueAt?: string
  estimatedMinutes: number
  leverage: number
  delayCost: number
  status: ActionStatus
  sourceLabel?: string
  createdAt: string
  updatedAt: string
}

export interface Prep {
  id: string
  title: string
  triggeredBy?: string
  priorityLabel?: string
  recentNodeAt?: string
  minimumOutput?: string
  estimatedMinutes: number
  triggerRule?: string
  sourceStatus?: string
  createdAt: string
  updatedAt: string
}

export interface ApplicationGroup {
  id: string
  company: string
  coveredRoles?: string
  rule?: string
  total?: number
  used?: number
  remaining?: number
  currentOrder?: string
  locked?: boolean
  nextAction?: string
  notes?: string
}

export interface PriorityBreakdown {
  opportunity: number
  fit: number
  urgency: number
  stage: number
  leverage: number
  delayCost: number
  timeEfficiency: number
}

export interface RankedAction {
  action: Action
  score: number
  breakdown: PriorityBreakdown
  reasons: string[]
}

export interface ImportSummary {
  filename: string
  importedAt: string
  opportunities: number
  pending: number
  processes: number
  prep: number
  applicationGroups: number
  actions: number
}

export interface ImportBundle {
  opportunities: Opportunity[]
  processes: ProcessRecord[]
  actions: Action[]
  prep: Prep[]
  applicationGroups: ApplicationGroup[]
  summary: ImportSummary
}

export interface ImportMeta extends ImportSummary {
  key: 'lastImport'
}
