from pathlib import Path

# DB: keep natural-language ChangeSets atomic and support reconstructed actions.
p = Path('src/db.ts')
s = p.read_text()
old = """export async function updateActionStatus(id: string, status: Action['status']) {
  const db = await dbPromise
  const tx = db.transaction(['actions', 'timeline'], 'readwrite')
  const action = await tx.objectStore('actions').get(id)
  if (!action || action.status === status) {
    await tx.done
    return
  }
  const now = new Date().toISOString()
  await tx.objectStore('actions').put({ ...action, status, updatedAt: now })
  await tx.objectStore('timeline').put(timelineFromActionStatus(action, action.status, status, now))
  await tx.done
}
"""
new = """export async function updateActionStatus(id: string, status: Action['status']) {
  const db = await dbPromise
  const stored = await db.get('actions', id)
  const action = stored ?? (await getAllActions()).find((item) => item.id === id)
  if (!action || action.status === status) return
  const now = new Date().toISOString()
  const tx = db.transaction(['actions', 'timeline'], 'readwrite')
  await tx.objectStore('actions').put({ ...action, status, updatedAt: now })
  await tx.objectStore('timeline').put(timelineFromActionStatus(action, action.status, status, now))
  await tx.done
}
"""
if old not in s: raise SystemExit('updateActionStatus anchor missing')
s = s.replace(old, new, 1)

old = """export async function applyActionStatusChangeSet(actionId: string, status: Action['status']) {
  const db = await dbPromise
  const action = await db.get('actions', actionId)
  if (!action) return undefined
"""
new = """export async function applyActionStatusChangeSet(actionId: string, status: Action['status']) {
  const db = await dbPromise
  const action = await db.get('actions', actionId) ?? (await getAllActions()).find((item) => item.id === actionId)
  if (!action) return undefined
"""
if old not in s: raise SystemExit('applyActionStatusChangeSet anchor missing')
s = s.replace(old, new, 1)

old = """  try {
    for (const operation of changeSet.operations) {
      if (operation.kind === 'progress_update') {
        await applyProgressUpdate([restoreProgressOperation(operation, changeSet.id)])
        continue
      }

      if (operation.kind === 'replace_decision_rules') {
"""
new = """  try {
    const progressOperations = changeSet.operations.filter((operation) => operation.kind === 'progress_update')
    if (progressOperations.length === changeSet.operations.length) {
      // The primary Natural Language Update path remains one IndexedDB transaction:
      // either every normalized operation is committed or none of them is.
      await applyProgressUpdate(progressOperations.map((operation) => restoreProgressOperation(operation, changeSet.id)))
    } else for (const operation of changeSet.operations) {
      if (operation.kind === 'progress_update') {
        await applyProgressUpdate([restoreProgressOperation(operation, changeSet.id)])
        continue
      }

      if (operation.kind === 'replace_decision_rules') {
"""
if old not in s: raise SystemExit('applyChangeSet loop anchor missing')
s = s.replace(old, new, 1)

old = """      const action = await db.get('actions', operation.actionId)
      if (!action) throw new Error(`Action ${operation.actionId} 已不存在。`)
"""
new = """      const action = await db.get('actions', operation.actionId) ?? (await getAllActions()).find((item) => item.id === operation.actionId)
      if (!action) throw new Error(`Action ${operation.actionId} 已不存在。`)
"""
if old not in s: raise SystemExit('applyChangeSet action anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# App: expose pending ChangeSet resolution in Timeline.
p = Path('src/AppV5.tsx')
s = p.read_text()
s = s.replace("  applyActionStatusChangeSet,\n} from './db'", "  applyActionStatusChangeSet,\n  applyChangeSet,\n  discardChangeSet,\n} from './db'")
anchor = """  async function markAction(id: string, status: Action['status']) {
    await applyActionStatusChangeSet(id, status)
    await reload()
  }
"""
replacement = anchor + """
  async function applyPendingChangeSet(id: string) {
    await applyChangeSet(id)
    await reload()
  }

  async function discardPendingChangeSet(id: string) {
    await discardChangeSet(id)
    await reload()
  }
"""
if anchor not in s: raise SystemExit('App markAction anchor missing')
s = s.replace(anchor, replacement, 1)
s = s.replace("<TimelineView records={timeline} changeSets={changeSets} />", "<TimelineView records={timeline} changeSets={changeSets} onApplyChangeSet={applyPendingChangeSet} onDiscardChangeSet={discardPendingChangeSet} />")
p.write_text(s)

# Timeline: a real review surface for pending ChangeSets.
p = Path('src/TimelineView.tsx')
s = p.read_text()
s = s.replace("export default function TimelineView({ records, changeSets }: { records: TimelineRecord[]; changeSets: ChangeSetRecord[] }) {", "export default function TimelineView({ records, changeSets, onApplyChangeSet, onDiscardChangeSet }: { records: TimelineRecord[]; changeSets: ChangeSetRecord[]; onApplyChangeSet: (id: string) => Promise<void>; onDiscardChangeSet: (id: string) => Promise<void> }) {")
s = s.replace("  const [source, setSource] = useState<'all' | TimelineSource>('all')", "  const [source, setSource] = useState<'all' | TimelineSource>('all')\n  const [busyChangeSetId, setBusyChangeSetId] = useState<string | null>(null)\n\n  async function resolveChangeSet(id: string, action: 'apply' | 'discard') {\n    setBusyChangeSetId(id)\n    try {\n      if (action === 'apply') await onApplyChangeSet(id)\n      else await onDiscardChangeSet(id)\n    } finally {\n      setBusyChangeSetId(null)\n    }\n  }")
old = """              <article className={`changeset-item status-${item.status}`} key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{item.id} · {changeSetSourceLabels[item.source][zh ? 0 : 1]} · {item.operations.length} {zh ? '项' : 'ops'}</small>
                </div>
                <span>{changeSetStatusLabels[item.status][zh ? 0 : 1]}</span>
              </article>
"""
new = """              <article className={`changeset-item status-${item.status}`} key={item.id}>
                <div className=\"changeset-item-copy\">
                  <strong>{item.title}</strong>
                  <small>{item.id} · {changeSetSourceLabels[item.source][zh ? 0 : 1]} · {item.operations.length} {zh ? '项' : 'ops'}</small>
                  <div className=\"changeset-operation-preview\">
                    {item.operations.slice(0, 5).map((operation) => <span key={operation.id}>{operation.summary}</span>)}
                    {item.operations.length > 5 ? <span>+{item.operations.length - 5}</span> : null}
                  </div>
                </div>
                <div className=\"changeset-item-state\">
                  <span>{changeSetStatusLabels[item.status][zh ? 0 : 1]}</span>
                  {item.status === 'pending' ? (
                    <div className=\"changeset-item-actions\">
                      <button disabled={busyChangeSetId === item.id} onClick={() => { void resolveChangeSet(item.id, 'discard') }}>{zh ? '放弃' : 'Discard'}</button>
                      <button className=\"apply\" disabled={busyChangeSetId === item.id} onClick={() => { void resolveChangeSet(item.id, 'apply') }}>{busyChangeSetId === item.id ? '…' : (zh ? '应用' : 'Apply')}</button>
                    </div>
                  ) : null}
                </div>
              </article>
"""
if old not in s: raise SystemExit('Timeline ChangeSet item anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('src/timeline.css')
s = p.read_text()
s += r'''
.changeset-item-copy { flex:1; }
.changeset-operation-preview { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; }
.changeset-operation-preview span { border:1px solid rgba(49,46,42,.08); border-radius:7px; padding:3px 6px; background:#faf8f4; color:#777169; font-size:10px; line-height:1.35; }
.changeset-item-state { display:flex; align-items:flex-end; flex-direction:column; gap:8px; }
.changeset-item-state > span { border:1px solid rgba(49,46,42,.1); border-radius:999px; padding:4px 8px; background:#f6f3ed; color:#6d675f; font-size:10.5px; white-space:nowrap; }
.changeset-item.status-pending .changeset-item-state > span { background:#fff4d9; color:#8b651c; }
.changeset-item.status-failed .changeset-item-state > span { background:#fbe8e4; color:#9a4c3d; }
.changeset-item.status-applied .changeset-item-state > span { background:#edf3ed; color:#526654; }
.changeset-item-actions { display:flex; gap:6px; }
.changeset-item-actions button { border:1px solid rgba(49,46,42,.12); border-radius:8px; padding:5px 9px; background:#fffdf9; color:#69645d; font:inherit; font-size:10.5px; cursor:pointer; }
.changeset-item-actions button.apply { background:#35322d; color:#fff; }
.changeset-item-actions button:disabled { opacity:.55; cursor:default; }
@media (max-width:620px) { .changeset-item { align-items:flex-start; flex-direction:column; } .changeset-item-state { align-items:flex-start; } }
'''
p.write_text(s)

# Regression source checks for the all-progress atomic path and normalized operations.
p = Path('tests/changeSet.test.ts')
s = p.read_text()
needle = """  it('creates an optimistic-concurrency rule ChangeSet only when rules differ', () => {
"""
insert = """  it('keeps multiple natural-language operations inside one ChangeSet', () => {
    const base = {
      sourceText: 'raw input must not persist',
      confidence: 'high' as const,
      occurredAt: '2026-09-11T01:00:00.000Z',
    }
    const operations: ExecutableProgressOperation[] = [
      { ...base, id: 'nl:a', kind: 'manual_action', title: '任务 A', estimatedMinutes: 20 },
      { ...base, id: 'nl:b', kind: 'manual_action', title: '任务 B', estimatedMinutes: 30 },
    ]
    const changeSet = createProgressChangeSet(operations, new Date('2026-09-11T01:10:00.000Z'))
    expect(changeSet.operations).toHaveLength(2)
    expect(changeSet.operations.every((item) => item.kind === 'progress_update')).toBe(true)
    expect(JSON.stringify(changeSet)).not.toContain('raw input must not persist')
  })

""" + needle
if needle not in s: raise SystemExit('ChangeSet test insertion anchor missing')
s = s.replace(needle, insert, 1)
p.write_text(s)
