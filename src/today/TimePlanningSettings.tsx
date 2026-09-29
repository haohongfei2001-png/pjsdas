import { useEffect, useState } from 'react'
import type { TimePlanningPreferences, WorkWindow } from '../timePlanningPreferences.js'
import { useUiLanguage } from '../uiLanguage.js'

const DAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function minute(value: string) {
  const [hour, part] = value.split(':').map(Number)
  return hour * 60 + part
}

export default function TimePlanningSettings({ value, onSetDefault, onSetWindows }: {
  value?: TimePlanningPreferences
  onSetDefault: (minutes: number) => Promise<void>
  onSetWindows: (windows: WorkWindow[]) => Promise<void>
}) {
  const { lang } = useUiLanguage()
  const zh = lang === 'zh'
  const [hours, setHours] = useState(value?.defaultDailyMinutes === undefined ? '' : String(value.defaultDailyMinutes / 60))
  const [windows, setWindows] = useState<WorkWindow[]>(value?.weeklyWindows ?? [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setHours(value?.defaultDailyMinutes === undefined ? '' : String(value.defaultDailyMinutes / 60))
    setWindows(value?.weeklyWindows ?? [])
  }, [value?.updatedAt])
  async function save(operation: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('')
    try { await operation(); setMessage(zh ? '可用时间已保存。' : 'Available time saved.') }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }
  return <div className="tsui-planning-settings">
    <p>{zh ? '默认每天可用多久？今天临时变化可直接在“今天”调整。' : 'Set your usual daily availability. Adjust just today from Today.'}</p>
    <form onSubmit={event => { event.preventDefault(); void save(() => onSetDefault(Math.round(Number(hours) * 60))) }}>
      <label>{zh ? '默认每日小时' : 'Usual hours per day'} <input type="number" min="0" max="24" step="0.5" required value={hours} onChange={event => setHours(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{zh ? '保存默认时间' : 'Save usual time'}</button>
    </form>
    <div className="tsui-work-windows">
      <strong>{zh ? '可选工作时段' : 'Optional work windows'}</strong>
      <p>{zh ? '只在指定日期限制可安排任务的时间；不设置则按每日可用时长规划。' : 'Limit planning on selected weekdays. Leave empty to use only daily available time.'}</p>
      {windows.map((window, index) => <div className="tsui-work-window" key={index}>
        <label>{zh ? '星期' : 'Day'} <select value={window.weekday} onChange={event => setWindows(previous => previous.map((item, at) => at === index ? { ...item, weekday: Number(event.target.value) } : item))}>{(zh ? DAY_ZH : DAY_EN).map((name, day) => <option value={day} key={day}>{name}</option>)}</select></label>
        <label>{zh ? '开始' : 'Start'} <input type="time" value={clock(window.startMinute)} onChange={event => setWindows(previous => previous.map((item, at) => at === index ? { ...item, startMinute: minute(event.target.value) } : item))} /></label>
        <label>{zh ? '结束' : 'End'} <input type="time" value={clock(window.endMinute)} onChange={event => setWindows(previous => previous.map((item, at) => at === index ? { ...item, endMinute: minute(event.target.value) } : item))} /></label>
        <button type="button" onClick={() => setWindows(previous => previous.filter((_, at) => at !== index))}>{zh ? '移除' : 'Remove'}</button>
      </div>)}
      <div className="tsui-planning-actions"><button type="button" disabled={busy || windows.length >= 21} onClick={() => setWindows(previous => [...previous, { weekday: 1, startMinute: 540, endMinute: 1020 }])}>{zh ? '添加时段' : 'Add window'}</button><button type="button" disabled={busy} onClick={() => { void save(() => onSetWindows(windows)) }}>{zh ? '保存时段' : 'Save windows'}</button></div>
    </div>
    {error ? <div role="alert">{error}</div> : null}
    {message ? <div role="status">{message}</div> : null}
  </div>
}
