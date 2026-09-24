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
export type OpportunityParticipationStatus = 'active' | 'abandoned'
export type OpportunityAssessmentStatus = 'unassessed' | 'provisional' | 'assessed' | 'legacy'
export type DatePrecision = 'date' | 'datetime'

export type ProcessStageProgress =
  | 'not_started'
  | 'action_required'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'waiting_result'

export type ProcessResult = 'pending' | 'advanced' | 'rejected' | 'offer' | 'closed_other'
export type ProcessParticipationState = 'active' | 'abandoned'

export type ScheduleNodeKind =
  | 'interview'
  | 'written_test'
  | 'assessment'
  | 'application_deadline'
  | 'follow_up'
  | 'prep_trigger'

export type ScheduleNodeState =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'superseded'
  | 'elapsed_unresolved'

export type ScheduleTemporalShape =
  | 'fixed_range'
  | 'deadline'
  | 'availability_window'
  | 'date_only'
  | 'estimated_date'

export type ScheduleConstraintKind = 'employer_hard' | 'user_plan' | 'system_suggestion'
export type ScheduleResolutionBasis = 'source_explicit' | 'user_explicit' | 'legacy_projection' | 'system_estimate'
export type ScheduleEstimateProvenance = 'source' | 'user' | 'system_default' | 'legacy_projection'

export interface ScheduleNodeTemporal {
  shape: ScheduleTemporalShape
  precision: DatePrecision
  timezone: string
  startAt?: string
  endAt?: string
  deadlineAt?: string
  date?: string
  rawExpression?: string
  resolutionBasis: ScheduleResolutionBasis
  legacyProjectionAt?: string
}

export interface ScheduleNode {
  id: string
  occurrenceId: string
  version: number
  opportunityId?: string
  processId?: string
  processEventId?: string
  kind: ScheduleNodeKind
  state: ScheduleNodeState
  temporal: ScheduleNodeTemporal
  constraintKind: ScheduleConstraintKind
  estimatedMinutes?: number
  estimateProvenance?: ScheduleEstimateProvenance
  evidenceRefs: string[]
  sourceVersionRefs: string[]
  relatedActionIds: string[]
  relatedPrepIds: string[]
  supersedesNodeId?: string
  supersededByNodeId?: string
  completedAt?: string
  cancelledAt?: string
  createdAt: string
  updatedAt: string
}
export type ExternalCapabilityId = 'chatgpt_tasks' | 'google_calendar'
export type ExternalCapabilityState = 'available' | 'not_authorized' | 'unsupported'
export type ReminderPurpose = 'upcoming' | 'deadline' | 'prep' | 'follow_up' | 'custom'
export type ReminderDeliveryOwner = 'pjsdas' | 'external_task' | 'external_calendar'
export type ReminderChannel = 'in_product' | 'task' | 'calendar'
export type ReminderIntentState = 'active' | 'paused' | 'cancelled' | 'unsupported'
export type ReminderOutboxState = 'pending' | 'succeeded' | 'failed' | 'unsupported' | 'cancelled'
export type ReminderOutboxOperation = 'upsert' | 'cancel'

export interface ReminderExternalLink {
  capability: ExternalCapabilityId
  externalId?: string
  externalUrl?: string
  state: 'unmapped' | 'mapped' | 'cancelled' | 'failed'
  lastReceiptAt?: string
  lastErrorCode?: string
}

export interface ReminderIntent {
  id: string
  scheduleNodeId: string
  scheduleNodeVersion: number
  purpose: ReminderPurpose
  triggerAt: string
  deliveryOwner: ReminderDeliveryOwner
  channel: ReminderChannel
  capability?: ExternalCapabilityId
  state: ReminderIntentState
  dedupeKey: string
  externalLink?: ReminderExternalLink
  createdAt: string
  updatedAt: string
}

export interface ReminderOutboxRecord {
  id: string
  reminderIntentId: string
  operation: ReminderOutboxOperation
  capability: ExternalCapabilityId
  state: ReminderOutboxState
  attemptCount: number
  nextAttemptAt?: string
  payloadFingerprint: string
  receiptCode?: string
  createdAt: string
  updatedAt: string
}

export type SemanticIntakeSourceKind = 'web' | 'paia' | 'gmail' | 'mcp' | 'iphone'
export type SemanticStatementMode =
  | 'assertion'
  | 'current_intent'
  | 'question'
  | 'quote'
  | 'example'
  | 'hypothetical'
  | 'rewrite_request'

export type SemanticConfidence = 'high' | 'medium' | 'low'

export interface SemanticIntakeSourceRef {
  kind: SemanticIntakeSourceKind
  sourceId: string
  sourceRecordId: string
  sourceVersion?: string
  observedAt: string
  assertedAt?: string
  timezone: string
  authorizationGrantId?: string
}

export interface SemanticTargetRef {
  opportunityId?: string
  company?: string
  role?: string
  occurrenceId?: string
  scheduleNodeId?: string
  occurrenceKind?: ScheduleNodeKind
  reminderIntentId?: string
}

export interface SemanticCandidateBase {
  id: string
  target?: SemanticTargetRef
  objectConfidence: SemanticConfidence
  eventConfidence: SemanticConfidence
  temporalConfidence?: SemanticConfidence
  evidenceRefs: string[]
  sourceVersionRefs: string[]
}

export type SemanticCandidate =
  | (SemanticCandidateBase & {
      kind: 'application_submitted'
      occurredAt?: string
    })
  | (SemanticCandidateBase & {
      kind: 'process_event'
      temporal?: ScheduleNodeTemporal
      eventType: ProcessEventType
      occurredAt?: string
      dueAt?: string
      duePrecision?: DatePrecision
      timingMode?: ActionTimingMode
      estimatedMinutes?: number
      notes?: string
      location?: string
      joinUrl?: string
    })
  | (SemanticCandidateBase & {
      kind: 'opportunity_deadline'
      deadline: string
      precision: DatePrecision
    })
  | (SemanticCandidateBase & {
      kind: 'occurrence_completed'
      occurredAt?: string
    })
  | (SemanticCandidateBase & {
      kind: 'occurrence_cancelled'
      occurredAt?: string
    })
  | (SemanticCandidateBase & {
      kind: 'occurrence_rescheduled'
      temporal: ScheduleNodeTemporal
    })
  | (SemanticCandidateBase & {
      kind: 'abandon_opportunity'
      occurredAt?: string
    })
  | (SemanticCandidateBase & {
      kind: 'manual_action'
      title: string
      dueAt?: string
      duePrecision?: DatePrecision
      estimatedMinutes?: number
    })
  | (SemanticCandidateBase & {
      kind: 'reminder_intent'
      purpose: ReminderPurpose
      triggerAt?: string
      offsetMinutesBefore?: number
      deliveryOwner?: ReminderDeliveryOwner
      channel?: ReminderChannel
    })
  | (SemanticCandidateBase & {
      kind: 'reminder_cancelled'
      purpose?: ReminderPurpose
    })
  | (SemanticCandidateBase & {
      kind: 'external_withdrawal'
    })

export interface SemanticIntakeObservation {
  contractVersion: 1
  inputId: string
  source: SemanticIntakeSourceRef
  statementMode: SemanticStatementMode
  originalText?: string
  originalTextFingerprint?: string
  contextRefs?: string[]
  candidates: SemanticCandidate[]
}

export type DecisionRequestReason =
  | 'ambiguous_target'
  | 'ambiguous_occurrence'
  | 'low_confidence'
  | 'material_conflict'
  | 'shared_governance'
  | 'external_consequence'
  | 'missing_required_field'
  | 'target_abandoned'

export type DecisionRequestState = 'open' | 'answered' | 'auto_resolved' | 'superseded' | 'expired'

export interface SemanticResolutionTarget {
  opportunityId?: string
  occurrenceId?: string
  reminderIntentId?: string
  confirm?: boolean
  dismiss?: boolean
}

export interface DecisionRequestChoice {
  id: string
  label: string
  consequence: string
  resolution?: SemanticResolutionTarget
}

export interface DecisionRequestPayloadBinding {
  contractVersion: 1
  inputId: string
  candidateId: string
  source: SemanticIntakeSourceRef
  statementMode: SemanticStatementMode
  candidate: SemanticCandidate
}

export interface DecisionRequest {
  id: string
  reason: DecisionRequestReason
  affectedObjects: Array<{ type: 'opportunity' | 'schedule_node' | 'application_group' | 'source' | 'reminder_intent'; id: string }>
  question: string
  choices: DecisionRequestChoice[]
  recommendedChoiceId?: string
  recommendationBasis?: string
  evidenceRefs: string[]
  payloadBinding: DecisionRequestPayloadBinding
  expiresAt?: string
  state: DecisionRequestState
  answerChoiceId?: string
  answeredAt?: string
  createdAt: string
  updatedAt: string
}

export type SemanticReceiptStatus = 'committed' | 'decision_required' | 'no_write' | 'undone'

export interface SemanticIntakeReceipt {
  id: string
  inputId: string
  sourceKind: SemanticIntakeSourceKind
  sourceId: string
  sourceRecordId: string
  sourceVersion?: string
  commandId?: string
  status: SemanticReceiptStatus
  summary: string
  affectedObjects: Array<{ type: 'opportunity' | 'schedule_node' | 'action' | 'process' | 'decision_request' | 'reminder_intent'; id: string }>
  decisionRequestIds: string[]
  factKeys?: string[]
  undoAvailable: boolean
  createdAt: string
  updatedAt: string
}

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

export type IngestionIssueKind = 'transport_gap' | 'interpretation_failure' | 'business_ambiguity'

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
  /** Known source capability limits; these do not imply a failed business interpretation. */
  capabilityBoundaries?: string[]
  /** Multiple classes may apply to one record; absence on old evidence stays unclassified. */
  issueKinds?: IngestionIssueKind[]
  opportunityId?: string
  processEventId?: string
  actionId?: string
}

export type IngestionProducer = 'server_scheduler' | 'mcp_trusted_ingestion'

export interface IngestionRunSummary {
  version: 1
  runId: string
  sourceKind: IngestionSourceKind
  sourceId: string
  producer?: IngestionProducer
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
  | 'paia'
  | 'mcp'
  | 'iphone'
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
  | 'semantic_intake_applied'
  | 'decision_requested'
  | 'decision_resolved'
  | 'semantic_undo_applied'
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
  scheduleNodeId?: string
  decisionRequestId?: string
  reminderIntentId?: string
  changeSetId?: string
  commandId?: string
  commandOperation?: string
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
  sourceVerification?: 'verified' | 'unverified'
  sourceVerifiedAt?: string
  fitConfidence: DiscoveryConfidence
  opportunityValueConfidence: DiscoveryConfidence
  profileWarnings?: string[]
  posting?: JobPostingEvidence
  postingHistory?: JobPostingEvidence[]
}

export interface OpportunityUserFacts {
  provenance: 'user_asserted'
  updatedAt: string
  location?: string
  compensationText?: string
  applicationUrl?: string
  deadline?: string
  deadlinePrecision?: DatePrecision
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
  userFacts?: OpportunityUserFacts
}

export interface Opportunity {
  id: string
  company: string
  role: string
  currentStageLabel: string
  processStage: ProcessStage
  roleType: OpportunityRole
  participationStatus?: OpportunityParticipationStatus
  abandonedAt?: string
  assessmentStatus?: OpportunityAssessmentStatus
  early: boolean
  deadline?: string
  deadlinePrecision?: DatePrecision
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
  progress?: ProcessStageProgress
  result?: ProcessResult
  participationState?: ProcessParticipationState
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
  temporal?: ScheduleNodeTemporal
  id: string
  opportunityId: string
  company: string
  role: string
  type: ProcessEventType
  occurredAt: string
  dueAt?: string
  duePrecision?: DatePrecision
  timingMode?: ActionTimingMode
  estimatedMinutes?: number
  notes?: string
  location?: string
  joinUrl?: string
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
  duePrecision?: DatePrecision
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
