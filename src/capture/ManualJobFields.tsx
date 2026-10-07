import type { UserJobFacts } from '../opportunityCreation.js'

export default function ManualJobFields({ value, onChange, disabled, zh }: {
  value: UserJobFacts; onChange: (value: UserJobFacts) => void; disabled: boolean; zh: boolean
}) {
  const edit = (key: keyof UserJobFacts, text: string) => onChange({ ...value, [key]: text || undefined })
  return <div className="cgr-manual-job">
    <div className="cgr-manual-job-identity">
      <label>{zh ? '公司名称' : 'Company name'}<input autoFocus required maxLength={120} value={value.company} disabled={disabled} onChange={event => onChange({ ...value, company: event.target.value })} /></label>
      <label>{zh ? '岗位名称' : 'Job title'}<input required maxLength={180} value={value.role} disabled={disabled} onChange={event => onChange({ ...value, role: event.target.value })} /></label>
    </div>
    <label>{zh ? '来源链接（选填）' : 'Source link (optional)'}<input type="url" maxLength={2000} value={value.sourceUrl ?? ''} disabled={disabled} placeholder="https://" onChange={event => edit('sourceUrl', event.target.value)} /></label>
    <details><summary>{zh ? '地点与截止日期＋' : 'Location and deadline +'}</summary>
      <div className="cgr-manual-job-identity">
        <label>{zh ? '地点（选填）' : 'Location (optional)'}<input maxLength={240} value={value.location ?? ''} disabled={disabled} onChange={event => edit('location', event.target.value)} /></label>
        <label>{zh ? '申请截止日期（选填）' : 'Application deadline (optional)'}<input type="date" value={value.deadline ?? ''} disabled={disabled} onChange={event => onChange({ ...value, deadline: event.target.value || undefined, deadlinePrecision: event.target.value ? 'date' : undefined })} /></label>
      </div>
    </details>
    <p>{zh ? '按你提供的信息保存，来源记为「用户添加」。' : 'Saved as provided, with source “Added by you”.'}</p>
  </div>
}
