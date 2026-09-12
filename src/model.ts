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

export type ProcessEventType =
  | 'assessment_invite'
  | 'written_test_invite'
  | 'interview_invite'
  | 'offer'
  | 'rejection'
  | 'status_update'
  | 'other'

export type ActionTimingMode = 'deadline' | 'fixed'
export type ActionKind = 'apply' | 'follow_up' | 'prep' | 'group_decision' | 'manual'
export type ActionStatus = 'todo' | 'doing' | 'done' | 'skipped'
export type PriorityLevel = 'P0' | 'P1' | 'P2' | 'expired' | 'none'
export type DiscoveryConfidence = 'high' | 'medium' | 'low'
export type DiscoveryReviewDecision = 'accepted' | 'rejected' | 'filtered' | 'duplicate' | 'deferred'
export type DiscoveryRejectionReason =
  | 'location'
  | 'compensation'
  | 'role_direction'
  | 'company_value'
  | 'requirements'
  | 'already_have_better'
  | 'not_interested'
  | 'other'

export type JobPostingStatus = 'open' | 'closed' | 'unknown'
export type JobPostingFreshness = 'fresh' | 'aging' | 'stale' | 'closed' | 'unknown'

export interface JobPostingEvidence {
  id: string
  identityKey: string
  sourceUrl: string
  canonicalSourceUrl: string
  sourceHost: string
  sourceTitle: string
  postingStatus: JobPostingStatus
  location?: string
  deadline?: string
  compensationText?: string
  firstSeenAt: string
  lastSeenAt: string
  lastVerifiedAt: string
  fingerprint: string
  supersededByPostingId?: string
}

export type OpportunityFactUnknownField =
  | 'department'
  | 'business_unit'
  | 'locations'
  | 'recruitment_batch'
  | 'responsibilities'
  | 'requirements'
  | 'education'
  | 'majors'
  | 'experience'
  | 'skills'
  | 'languages'
  | 'application_method'
  | 'deadline'
  | 'compensation'

export interface OpportunityFacts {
  version: 1
  identity: {
    department?: string
    businessUnit?: string
    locations?: string[]
    recruitmentBatch?: string
  }
  role: {
    responsibilities?: string[]
    requirements?: string[]
    educationRequirement?: string
    majorRequirements?: string[]
    experienceRequirement?: string
    skills?: string[]
    languageRequirements?: string[]
  }
  application: {
    applicationUrl?: string
    applicationMethod?: string
    deadline?: string
    recruitmentBatch?: string
  }
  compensation: {
    raw?: string
    annualMinWan?: number
    annualMaxWan?: number
    basis?: string
  }
  evidence: {
    sourceUrl: string
    sourceTitle: string
    verifiedAt: string
    evidenceSummary?: string
  }
  unknownFields: OpportunityFactUnknownField[]
}

export type FitAssessmentComponentKey =
  | 'roleDirection'
  | 'skills'
  | 'education'
  | 'experience'
  | 'industry'
  | 'language'
  | 'location'

export type OpportunityValueAssessmentComponentKey =
  | 'companyQuality'
  | 'roleGrowth'
  | 'compensation'
  | 'careerOptionality'
  | 'brandValue'
  | 'industryGrowth'
  | 'locationValue'

export interface OpportunityAssessmentComponent {
  score: number
  confidence: DiscoveryConfidence
  rationale: string
}

export interface OpportunityAssessment {
  version: 1
  mode: 'component'
  fit: Partial<Record<FitAssessmentComponentKey, OpportunityAssessmentComponent>>
  opportunityValue: Partial<Record<OpportunityValueAssessmentComponentKey, OpportunityAssessmentComponent>>
  assessedAt: string
}

export type DiscoveryInboxStatus = 'new' | 'seen' | 'later' | 'dismissed' | 'promoted'

export interface DiscoveryInboxItem {
  id: string
  candidateOpportunityId: string
  company: string
  role: string
  roleType: OpportunityRole
  sourceUrl: string
  sourceTitle: string
  location?: string
  deadline?: string
  compensationText?: string
  rationale: string
  opportunityValue: number
  fitScore: number
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  profileWarnings?: string[]
  posting?: JobPostingEvidence
  postingHistory?: JobPostingEvidence[]
  facts?: OpportunityFacts
  assessment?: OpportunityAssessment
  status: DiscoveryInboxStatus
  rejectionReason?: DiscoveryRejectionReason
  sourceChangeSetId?: string
  sourceOperationId?: string
  discoveredAt: string
  createdAt: string
  updatedAt: string
  seenAt?: string
  promotedOpportunityId?: string
}

export type IngestionSourceKind = 'gpt_monitor' | 'gmail' | 'natural_language' | 'manual'
export type IngestionRecordType = 'job_observation' | 'recruiting_message'
export type IngestionOutcome =
  | 'created'
  | 'merged'
  | 'updated'
  | 'duplicate'
  | 'filtered'
  | 'ignored'
  | 'unresolved'

export interface IngestionLedgerEntry {
  version: 1
  sourceKind: IngestionSourceKind
  sourceId: string
  sourceRecordId: string
  runId: string
  recordType: IngestionRecordType
  outcome: IngestionOutcome
  fingerprint: string
  receivedAt: string
  accountedAt: string
  reason?: string
  opportunityId?: string
  processEventId?: string
  actionId?: string
}

export interface IngestionRunSummary {
  version: 1
  runId: string
  sourceKind: IngestionSourceKind
  sourceId: string
  startedAt: string
  completedAt: string
  receivedCount: number
  accountedCount: number
  outcomes: Partial<Record<IngestionOutcome, number>>
  cursor?: string
}

export type TimelineCategory = 'opportunity' | 'process' | 'action' | 'rules' | 'change' | 'data' | 'note'
export type TimelineSource =
  | 'excel'
  | 'natural_language'
  | 'process_event'
  | 'user_action'
  | 'rules'
  | 'backup'
  | 'system'
  | 'changeset'
  | 'automation'
  | 'gmail'
export type TimelineKind =
  | 'history_imported'
  | 'opportunity_added'
  | 'opportunity_updated'
  | 'application_submitted'
  | 'opportunity_renamed'
  | 'process_event_recorded'
  | 'process_closed'
  | 'process_event_deleted'
  | 'action_added'
  | 'action_status_changed'
  | 'rules_changed'
  | 'excel_imported'
  | 'backup_restored'
  | 'baseline_backfill'
  | 'change_set_applied'
  | 'discovery_accepted'
  | 'discovery_rejected'
  | 'discovery_filtered'
  | 'discovery_duplicate'
  | 'discovery_deferred'
  | 'ingestion_recorded'
  | 'ingestion_run_completed'
export type TimelineChangeValue = string | number | boolean | null
export interface TimelineFieldChange {
  before?: TimelineChangeValue
  after?: TimelineChangeValue
}
export interface TimelineRecord {
  id: string
  kind: TimelineKind
  category: TimelineCategory
  source: TimelineSource
  occurredAt: string
  recordedAt: string
  title: string
  detail?: string
  opportunityId?: string
  actionId?: string
  processEventId?: string
  changeSetId?: string
  company?: string
  role?: string
  sourceRef?: string
  discoveryDecision?: DiscoveryReviewDecision
  discoveryReasonCode?: DiscoveryRejectionReason
  discoveryQualityScore?: number
  ingestion?: IngestionLedgerEntry
  ingestionRun?: IngestionRunSummary
  changes?: Record<string, TimelineFieldChange>
}

export interface OpportunityDiscoveryEvidence {
  sourceUrl: string
  sourceTitle: string
  location?: string
  compensationText?: string
  rationale: string
  discoveredAt: string
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  profileWarnings?: string[]
  posting?: JobPostingEvidence
  postingHistory?: JobPostingEvidence[]
}

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
  facts?: OpportunityFacts
  assessment?: OpportunityAssessment
  discovery?: OpportunityDiscoveryEvidence
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
  effectiveProcessEventId?: string
  effectiveProcessEventAt?: string
  locallyManaged?: boolean
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
  effectiveProcessEventId?: string
  effectiveProcessEventAt?: string
  locallyManaged?: boolean
}

export interface ProcessEvent {
  id: string
  opportunityId: string
  company: string
  role: string
  type: ProcessEventType
  occurredAt: string
  dueAt?: string
  timingMode?: ActionTimingMode
  estimatedMinutes?: number
  notes?: string
  source: 'manual' | 'email' | 'other'
  createdAt: string
  updatedAt: string
}

export interface Action {
  id: string
  kind: ActionKind
  title: string
  opportunityId?: string
  prepId?: string
  applicationGroupId?: string
  processEventId?: string
  processStage?: ProcessStage
  dueAt?: string
  timingMode?: ActionTimingMode
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
  timeline?: TimelineRecord[]
  summary: ImportSummary
}

export interface ImportMeta extends ImportSummary {
  key: 'lastImport'
}
