from pathlib import Path

p = Path('src/decisionCoreV3.ts')
s = p.read_text()
old = "reasons.push(processTask ? '流程节点48小时内' : '明天硬截止')"
new = "reasons.push(processTask ? `流程节点${rules.hardDeadlineHorizonHours}小时内` : `${rules.hardDeadlineHorizonHours}小时内硬截止`)"
if old not in s:
    raise SystemExit('decision reason anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('src/AppV5.tsx')
s = p.read_text()
old = '<div className="eyebrow">UPCOMING · NEXT 7 DAYS</div>'
new = "<div className=\"eyebrow\">{lang === 'zh' ? `UPCOMING · 未来 ${rules.upcomingHorizonDays} 天` : `UPCOMING · NEXT ${rules.upcomingHorizonDays} DAYS`}</div>"
count = s.count(old)
if count != 2:
    raise SystemExit(f'expected 2 upcoming labels, found {count}')
s = s.replace(old, new)
p.write_text(s)
