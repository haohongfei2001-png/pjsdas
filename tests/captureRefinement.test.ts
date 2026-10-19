import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { captureExamples } from '../src/capture/captureExamples.js'
import { buildWebSemanticInterpretation } from '../src/webSemanticInterpretation.js'
import { createSnapshot } from '../src/snapshot.js'
import { semanticIntakeSchema } from '../gateway/semanticIntake.js'
import { applySemanticIntake } from '../src/semanticIntake.js'

const now = new Date('2026-10-19T00:00:00Z')
const source = readFileSync(new URL('../src/TellPjsdasCapture.tsx', import.meta.url), 'utf8')

describe('capture refinement keeps public examples honest and confirmation intact', () => {
  for (const [locale, examples] of Object.entries(captureExamples)) {
    for (const timezone of ['UTC', 'Asia/Shanghai']) {
      it(`interprets the displayed ${locale} examples with ${timezone}, without losing time`, () => {
        for (const [index, text] of examples.entries()) {
          const snapshot = createSnapshot({ opportunities: [], processes: [], processEvents: [], actions: [], prep: [], applicationGroups: [], timeline: [] })
          const parsed = buildWebSemanticInterpretation(text, [], snapshot, [], now, timezone)
          expect(parsed.unresolved).toEqual([])
          expect(parsed.candidates).toHaveLength(1)
          expect(parsed.candidates[0]).toMatchObject({ kind: 'manual_action', plannedDate: index === 0 ? '2026-10-19' : '2026-10-20' })
          if (index === 1) expect(parsed.candidates[0]).toMatchObject({ scheduledTemporal: {
            startAt: `2026-10-20T15:00:00${timezone === 'UTC' ? '+00:00' : '+08:00'}`, timezone,
          } })
          const input = semanticIntakeSchema.parse({ contractVersion: 1, inputId: `example-${locale}-${index}`, originalText: text,
            statementMode: parsed.mode, source: { kind: 'web', sourceId: 'example', sourceRecordId: `example-${locale}-${index}`,
              observedAt: now.toISOString(), assertedAt: now.toISOString(), timezone }, candidates: parsed.candidates })
          const result = applySemanticIntake(snapshot, input, { authorized: true, now })
          expect(result.status).toBe('APPLIED')
          expect(result.snapshot.data.actions).toHaveLength(1)
          expect(result.snapshot.data.prep).toEqual([])
          if (index === 1) expect(result.snapshot.data.actions[0]!.scheduledTemporal).toMatchObject({ timezone })
        }
      })
    }
  }
  it('uses neutral examples and keeps the real review-before-save wording', () => {
    expect(source).toContain("captureExamples[zh ? 'zh' : 'en']")
    expect(source).not.toMatch(/京东|小鹏|任意表达|AI 会帮你/)
    expect(source).toContain('先核对整理结果，再确认保存')
    expect(source).toContain('确认并保存')
    expect(source).toContain('aria-describedby="tell-pjsdas-input-hint"')
  })
  it('groups secondary entries without removing any preview interaction guard', () => {
    expect(source).toContain('className="cgr-capture-secondary"')
    expect(source).toContain("previewPresentation.current.hold('pointer', true)")
    expect(source).toContain("previewPresentation.current.hold('pointer', false)")
    expect(source).toContain("previewPresentation.current.hold('focus', true)")
    expect(source).toContain("previewPresentation.current.hold('focus', false)")
  })
})
