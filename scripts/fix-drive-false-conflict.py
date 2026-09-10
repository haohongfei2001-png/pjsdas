from pathlib import Path

rules_path = Path('src/decisionRules.ts')
rules = rules_path.read_text()
anchor = "export function createDefaultDecisionRules(now = new Date().toISOString()): DecisionRules {\n  return { ...DEFAULT_DECISION_RULES, weights: { ...DEFAULT_DECISION_RULES.weights }, updatedAt: now }\n}\n"
addition = anchor + "\nexport function decisionRulesForSnapshot(rules?: DecisionRules): DecisionRules {\n  return rules ? cloneDecisionRules(rules) : cloneDecisionRules(DEFAULT_DECISION_RULES)\n}\n"
if 'export function decisionRulesForSnapshot' not in rules:
    if anchor not in rules:
        raise SystemExit('decisionRules anchor missing')
    rules = rules.replace(anchor, addition, 1)
    rules_path.write_text(rules)

db_path = Path('src/db.ts')
db = db_path.read_text()
old_import = "import { createDefaultDecisionRules, validateDecisionRules, type DecisionRules } from './decisionRules'"
new_import = "import { createDefaultDecisionRules, decisionRulesForSnapshot, validateDecisionRules, type DecisionRules } from './decisionRules'"
if old_import in db:
    db = db.replace(old_import, new_import, 1)
elif new_import not in db:
    raise SystemExit('db decisionRules import anchor missing')

old_get = "  return stored ?? createDefaultDecisionRules()\n"
new_get = "  return stored ?? decisionRulesForSnapshot()\n"
if old_get in db:
    db = db.replace(old_get, new_get, 1)
elif new_get not in db:
    raise SystemExit('getDecisionRules anchor missing')

old_snapshot = "    decisionRules: decisionRules ?? createDefaultDecisionRules(),\n"
new_snapshot = "    decisionRules: decisionRulesForSnapshot(decisionRules),\n"
if old_snapshot in db:
    db = db.replace(old_snapshot, new_snapshot, 1)
elif new_snapshot not in db:
    raise SystemExit('exportLocalSnapshot decisionRules anchor missing')

db_path.write_text(db)

test_path = Path('tests/decisionRulesSnapshotStability.test.ts')
test_path.write_text("""import { describe, expect, it } from 'vitest'\nimport {\n  DEFAULT_DECISION_RULES,\n  createDefaultDecisionRules,\n  decisionRulesForSnapshot,\n} from '../src/decisionRules'\n\ndescribe('decision rules snapshot stability', () => {\n  it('uses a stable default rule record when no rules have been persisted', () => {\n    const first = decisionRulesForSnapshot()\n    const second = decisionRulesForSnapshot()\n\n    expect(first).toEqual(second)\n    expect(first.updatedAt).toBe(DEFAULT_DECISION_RULES.updatedAt)\n    expect(first).not.toBe(second)\n    expect(first.weights).not.toBe(second.weights)\n  })\n\n  it('preserves an explicitly persisted rule record', () => {\n    const stored = createDefaultDecisionRules('2026-09-11T05:00:00.000Z')\n    stored.hardDeadlineHorizonHours = 72\n\n    const snapshotRules = decisionRulesForSnapshot(stored)\n    expect(snapshotRules).toEqual(stored)\n    expect(snapshotRules).not.toBe(stored)\n    expect(snapshotRules.weights).not.toBe(stored.weights)\n  })\n})\n""")
