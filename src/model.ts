export type OpportunityTier = 'practice' | 'early' | 'core' | 'reach' | 'lottery'

export type ProcessStage =
  | 'not_applied'
  | 'applied'
  | 'assessment'
  | 'written_test'
  | 'interview'
  | 'offer'
  | 'closed'

export type ActionStatus = 'todo' | 'doing' | 'done' | 'skipped'

export interface Opportunity {
  id: string
  company: string
  role: string
  location?: string
  track?: string
  tier?: OpportunityTier
  fitScore?: number
  opportunityValue?: number
  deadline?: string
  sourceUrl?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface ProcessRecord {
  id: string
  opportunityId: string
  stage: ProcessStage
  updatedAt: string
  notes?: string
}

export interface Action {
  id: string
  title: string
  opportunityId?: string
  prepId?: string
  dueAt?: string
  estimatedMinutes: number
  leverage: number
  delayCost: number
  status: ActionStatus
  createdAt: string
  updatedAt: string
}

export interface Prep {
  id: string
  title: string
  category?: string
  estimatedMinutes: number
  reuseValue: number
  status: ActionStatus
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface PriorityBreakdown {
  opportunity: number
  fit: number
  urgency: number
  leverage: number
  delayCost: number
  timeEfficiency: number
}

export interface RankedAction {
  action: Action
  score: number
  breakdown: PriorityBreakdown
}
