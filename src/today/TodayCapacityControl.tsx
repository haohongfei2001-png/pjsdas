import { useEffect, useRef, useState } from 'react'
import { capacityMinutesFromHours, type CapacitySaveState, type createCapacityAutosaver } from './capacityAutosave.js'

export default function TodayCapacityControl({ minutes, manualMinutes, scope, zh, readOnly, autosave, saveState }: {
  minutes: number
  manualMinutes?: number
  scope: string
  zh: boolean
  readOnly: boolean
  autosave: ReturnType<typeof createCapacityAutosaver>
  saveState: CapacitySaveState
}) {
  const label = (amount: number) => {
    const hours = Math.floor(amount / 60), rest = amount % 60
    return zh ? `${hours ? `${hours} 小时` : ''}${hours && rest ? ' ' : ''}${rest || !hours ? `${rest} 分钟` : ''}`
      : `${hours ? `${hours}h` : ''}${hours && rest ? ' ' : ''}${rest || !hours ? `${rest}m` : ''}`
  }
  const [hours, setHours] = useState(manualMinutes === undefined ? '' : String(manualMinutes / 60))
  const [error, setError] = useState('')
  const dirty = useRef(false)
  const closeOnSave = useRef(false)
  const details = useRef<HTMLDetailsElement>(null)
  const seenSaveState = useRef(saveState)
  const current = useRef({ manualMinutes, scope, zh })
  current.current = { manualMinutes, scope, zh }
  useEffect(() => {
    dirty.current = false
    setHours(current.current.manualMinutes === undefined ? '' : String(current.current.manualMinutes / 60)); setError('')
  }, [scope])
  useEffect(() => {
    if (!dirty.current) setHours(manualMinutes === undefined ? '' : String(manualMinutes / 60))
  }, [manualMinutes])
  useEffect(() => {
    const state = saveState
    const fresh = state !== seenSaveState.current
    seenSaveState.current = state
    if (!state.intent || state.intent.scope !== scope) return
    if (state.pending) {
      if (!dirty.current) { dirty.current = true; setHours(String(state.intent.minutes / 60)) }
      return
    }
    // A remount must not replay an old success over a newer authoritative value.
    if (!fresh && !state.error) return
    if (state.error) {
      if (!state.outdated) {
        dirty.current = false
        setHours(current.current.manualMinutes === undefined ? '' : String(current.current.manualMinutes / 60))
      }
      setError(state.error instanceof Error ? state.error.message : (current.current.zh ? '未能保存，请重试。' : 'Could not save. Please try again.'))
    } else {
      dirty.current = false
      setHours(String(state.intent.minutes / 60)); setError('')
      if (closeOnSave.current && details.current) details.current.open = false
    }
  }, [saveState, scope])
  function edit(value: string, valid = true) {
    dirty.current = true; closeOnSave.current = false; setHours(value); setError('')
    const amount = valid ? capacityMinutesFromHours(value) : undefined
    if (amount === undefined || readOnly) { autosave.cancelDraft(); return }
    autosave.schedule({ minutes: amount, scope })
  }
  function finish() {
    if (capacityMinutesFromHours(hours) === undefined) {
      autosave.cancelDraft(); dirty.current = false
      if (hours.trim()) setError(zh ? '请输入 0 到 24 之间的小时数。' : 'Enter a number of hours from 0 to 24.')
      setHours(manualMinutes === undefined ? '' : String(manualMinutes / 60))
    } else autosave.flush()
  }
  return <details ref={details} className="tsui-capacity"><summary>{zh ? `今天可用 ${label(minutes)} · 调整` : `${label(minutes)} available · Adjust`}</summary>
    <form aria-busy={saveState.pending} onSubmit={event => { event.preventDefault(); closeOnSave.current = true; finish() }}>
      <div className="tsui-capacity-options" role="group" aria-label={zh ? '今天可用时间' : 'Available time today'}>
        {[3, 6].map(amount => <button key={amount} type="button" disabled={readOnly} onPointerDown={event => event.preventDefault()} onClick={() => { edit(String(amount)); closeOnSave.current = true; autosave.flush() }}>{zh ? `${amount} 小时` : `${amount} hours`}</button>)}
        <label className="tsui-capacity-custom"><input aria-label={zh ? '今天可用小时' : 'Hours available today'} type="number" min="0" max="24" step="any" placeholder={zh ? '自定义' : 'Custom'} disabled={readOnly} value={hours} onChange={event => edit(event.target.value, event.target.validity.valid)} onBlur={finish} /><span aria-hidden="true">{zh ? '小时' : 'h'}</span></label>
      </div>
      {error ? <span role="alert">{error}</span> : null}
    </form>
  </details>
}
