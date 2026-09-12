import type {
  FitAssessmentComponentKey,
  OpportunityAssessment,
  OpportunityValueAssessmentComponentKey,
} from './model.js'
import './opportunityAssessment.css'

const fitLabels: Record<FitAssessmentComponentKey, [string, string]> = {
  roleDirection: ['岗位方向', 'Role direction'],
  skills: ['技能', 'Skills'],
  education: ['学历', 'Education'],
  experience: ['经验', 'Experience'],
  industry: ['行业', 'Industry'],
  language: ['语言', 'Language'],
  location: ['地点', 'Location'],
}

const opportunityLabels: Record<OpportunityValueAssessmentComponentKey, [string, string]> = {
  companyQuality: ['公司质量', 'Company quality'],
  roleGrowth: ['岗位成长', 'Role growth'],
  compensation: ['薪资价值', 'Compensation'],
  careerOptionality: ['职业选择权', 'Career optionality'],
  brandValue: ['品牌价值', 'Brand value'],
  industryGrowth: ['行业成长', 'Industry growth'],
  locationValue: ['地点价值', 'Location value'],
}

function confidenceLabel(value: string, zh: boolean) {
  if (!zh) return value
  if (value === 'high') return '高'
  if (value === 'medium') return '中'
  return '低'
}

export default function OpportunityAssessmentSummary({
  assessment,
  fitScore,
  opportunityValue,
  fitConfidence,
  opportunityValueConfidence,
  zh,
}: {
  assessment?: OpportunityAssessment
  fitScore: number
  opportunityValue: number
  fitConfidence?: string
  opportunityValueConfidence?: string
  zh: boolean
}) {
  if (!assessment) return null
  const fitEntries = Object.entries(assessment.fit) as Array<[FitAssessmentComponentKey, NonNullable<OpportunityAssessment['fit'][FitAssessmentComponentKey]>]>
  const opportunityEntries = Object.entries(assessment.opportunityValue) as Array<[OpportunityValueAssessmentComponentKey, NonNullable<OpportunityAssessment['opportunityValue'][OpportunityValueAssessmentComponentKey]>]>

  return (
    <details className="opportunity-assessment-summary">
      <summary>
        <span>{zh ? '分项评估' : 'Component assessment'}</span>
        <strong>{zh ? `匹配 ${Math.round(fitScore)} · 价值 ${Math.round(opportunityValue)}` : `Fit ${Math.round(fitScore)} · Value ${Math.round(opportunityValue)}`}</strong>
      </summary>
      <p className="opportunity-assessment-note">
        {zh
          ? '这些是评估判断，不是招聘事实。PJSDAS 根据显式组件权重聚合总分；缺失组件不会被填成中性分。'
          : 'These are assessment judgments, not recruiting facts. PJSDAS aggregates them using explicit component weights; missing components are not given neutral scores.'}
      </p>
      <div className="opportunity-assessment-axis">
        <div className="opportunity-assessment-axis-head">
          <strong>{zh ? '匹配度' : 'Fit'}</strong>
          <span>{Math.round(fitScore)} · {confidenceLabel(fitConfidence ?? 'low', zh)}</span>
        </div>
        {fitEntries.map(([key, component]) => (
          <div className="opportunity-assessment-component" key={`fit:${key}`}>
            <div><strong>{fitLabels[key][zh ? 0 : 1]}</strong><span>{component.score} · {confidenceLabel(component.confidence, zh)}</span></div>
            <p>{component.rationale}</p>
          </div>
        ))}
      </div>
      <div className="opportunity-assessment-axis">
        <div className="opportunity-assessment-axis-head">
          <strong>{zh ? '机会价值' : 'Opportunity Value'}</strong>
          <span>{Math.round(opportunityValue)} · {confidenceLabel(opportunityValueConfidence ?? 'low', zh)}</span>
        </div>
        {opportunityEntries.map(([key, component]) => (
          <div className="opportunity-assessment-component" key={`opportunity:${key}`}>
            <div><strong>{opportunityLabels[key][zh ? 0 : 1]}</strong><span>{component.score} · {confidenceLabel(component.confidence, zh)}</span></div>
            <p>{component.rationale}</p>
          </div>
        ))}
      </div>
      <small>{zh ? '评估时间' : 'Assessed'}：{new Date(assessment.assessedAt).toLocaleString()}</small>
    </details>
  )
}
