import { test } from './support/voiceoverMockTest.js'
import { expect, type Locator } from '@playwright/test'
import { prepareJourney, waitForJourneyReady } from './support/cgr02Journey.js'
import { namedVoiceOverItem as namedItem } from './support/voiceoverItemText.js'

test('real VoiceOver can find Today, Tell TodayAction and the authoritative saved result', async ({ page, voiceOver }, testInfo) => {
  type Observation = { item: string; spoken: string[]; full: boolean }
  const observations: Array<Observation & { action: string }> = []
  const compact = (value: string) => value.replace(/\s+/g, '')
  const capture = async (action: string, perform: () => Promise<unknown>, full = true): Promise<Observation> => {
    const start = (await voiceOver.spokenPhraseLog()).length
    await perform()
    const observation = { item: await voiceOver.itemText(), spoken: (await voiceOver.spokenPhraseLog()).slice(start), full }
    observations.push({ action, ...observation })
    return observation
  }
  const speaks = (observation: Observation, name: string) => compact(observation.spoken.join(' ')).includes(compact(name))
  const controls = page.locator('button, input:not([type="hidden"]), textarea, select, a[href], [role="button"], [role="textbox"], [tabindex]').filter({ visible: true })
  const findControl = async (name: string, role: 'button' | 'textbox', direction: 'next' | 'previous', current: Observation, spokenName = name, textbox?: Locator) => {
    // One pass over this fixture's currently visible control inventory, not a
    // retry budget. Different controls may legitimately share the same name.
    const limit = await controls.count()
    const metadata = textbox ? { value: await textbox.inputValue(), placeholder: await textbox.getAttribute('placeholder') ?? '' } : undefined
    for (let step = 0; step <= limit; step += 1) {
      if (namedItem(current.item, name, role, metadata)) {
        if (!current.full || !speaks(current, spokenName)) {
          current = await capture(`describe ${name}`, () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
        }
        expect(namedItem(current.item, name, role, metadata), JSON.stringify(current)).toBe(true)
        expect(speaks(current, spokenName), JSON.stringify(current)).toBe(true)
        if (role === 'button') expect(current.spoken.join(' ')).toMatch(/\bbutton\b/i)
        return current
      }
      if (step === limit) break
      current = await capture(`${direction} control for ${name}`, () => voiceOver.perform(
        direction === 'next' ? voiceOver.keyboardCommands.findNextControl : voiceOver.keyboardCommands.findPreviousControl,
        // Inspect each native item without waiting through every usage hint.
        // The exact target is described with full capture above.
        { capture: 'initial' },
      ), false)
    }
    throw new Error(`VoiceOver did not reach the exact ${role} "${name}" within one pass of ${limit} controls: ${JSON.stringify(observations)}`)
  }

  try {
    await prepareJourney(page)
    await page.goto('/pjsdas/today')
    await waitForJourneyReady(page)
    await expect(page.getByRole('heading', { name: 'A第一任务', exact: true })).toBeVisible()

    await page.bringToFront()
    await page.locator('.tsui-brand').focus()
    // Establish web entry once. Subsequent interaction stays on the native VO
    // cursor; CDP DOM focus alone does not establish macOS keyboard/AX focus.
    let current = await capture('enter at brand', () => voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus, { capture: true }))
    expect(namedItem(current.item, 'TodayAction，今天', 'button'), JSON.stringify(current)).toBe(true)
    // A new-window announcement can replace web-entry speech. Describe the
    // verified native item once; a correct item never substitutes for speech.
    if (!speaks(current, 'TodayAction，今天')) {
      current = await capture('describe brand after web entry', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
    }
    expect(namedItem(current.item, 'TodayAction，今天', 'button'), JSON.stringify(current)).toBe(true)
    expect(speaks(current, 'TodayAction，今天'), JSON.stringify(current)).toBe(true)
    const headingPhrases: string[] = []
    const headingLimit = Math.min(24, await page.getByRole('heading').count())
    let foundTodayTask = false
    for (let i = 0; i < headingLimit; i += 1) {
      current = await capture('next heading', () => voiceOver.nextHeading({ capture: 'initial' }), false)
      headingPhrases.push(...current.spoken)
      // Identify the real native heading first, not a possibly interrupted
      // initial announcement. Only its complete spoken description passes.
      if (/^A第一任务headinglevel[1-6]$/.test(compact(current.item))) {
        current = await capture('describe Today task heading', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
        headingPhrases.push(...current.spoken)
        expect(/^A第一任务headinglevel[1-6]$/.test(compact(current.item)), JSON.stringify(current)).toBe(true)
        foundTodayTask = speaks(current, 'A第一任务')
        break
      }
    }
    expect(foundTodayTask, headingPhrases.join(' | ')).toBe(true)

    const openerName = '＋ 告诉 TodayAction'
    await expect(page.locator('.tsui-capture-region').getByRole('button', { name: openerName, exact: true })).toBeEnabled()
    // The decorative plus may be pronounced as a word; AX identity still uses
    // the exact complete name, while speech must name the full button function.
    current = await findControl(openerName, 'button', 'next', current, '告诉 TodayAction')
    // Guidepup act performs the actual VoiceOver cursor's native AX action.
    // capture:true retains the complete announcement, not only its first chunk.
    current = await capture('activate capture opener', () => voiceOver.act({ capture: true }))
    const dialog = page.getByRole('dialog', { name: '告诉 TodayAction', exact: true })
    await expect(dialog).toHaveAttribute('aria-modal', 'false')
    const inputName = '要告诉 TodayAction 的内容'
    const input = dialog.getByRole('textbox', { name: inputName, exact: true })
    await expect(input).toBeFocused()
    // Native activation need not move the VO cursor into a nonmodal dialog.
    // Verify actual reachability and the full spoken input name independently.
    current = await capture('describe current item after opening', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
    current = await findControl(inputName, 'textbox', 'next', current, inputName, input)

    await input.fill('事项：填写报销单')
    await expect(dialog.getByText(/新增行动 · 填写报销单/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: '确认并保存', exact: true })).toBeEnabled()
    current = await findControl('确认并保存', 'button', 'next', current)
    const receiptObservationStart = observations.length
    current = await capture('activate authoritative save', () => voiceOver.act({ capture: true }))
    await expect(dialog.getByRole('status')).toContainText('已记录：填写报销单')
    await expect(input).toBeFocused()
    const isReceipt = (phrases: string[]) => {
      const spoken = phrases.join(' ')
      return spoken.includes('已记录') && spoken.includes('填写报销单')
    }
    // Both receipt tokens must come from one complete native action capture;
    // initial navigation snippets and unrelated actions cannot satisfy this.
    const receiptWasSpoken = () => observations.slice(receiptObservationStart).some(observation => observation.full && isReceipt(observation.spoken))
    let foundReceipt = receiptWasSpoken()
    if (!foundReceipt) {
      // Re-enter through real native control navigation, never a CDP-focus repair.
      current = await capture('describe current item after saving', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
      current = await findControl(inputName, 'textbox', 'next', current, inputName, input)
      foundReceipt = receiptWasSpoken()
      // The receipt follows the textarea/tools in this settled composer. Bound
      // reading to its visible DOM elements, rather than looping the whole page.
      const receiptLimit = Math.min(32, await dialog.locator('*:visible').count())
      for (let i = 0; i < receiptLimit && !foundReceipt; i += 1) {
        current = await capture('next item toward saved receipt', () => voiceOver.next({ capture: 'initial' }), false)
        if (compact(current.item) === '已保存' || isReceipt([current.item])) {
          current = await capture('describe saved receipt', () => voiceOver.perform(voiceOver.keyboardCommands.describeItem, { capture: true }))
        }
        foundReceipt = receiptWasSpoken()
      }
    }
    const receiptPhrases = observations.slice(receiptObservationStart).flatMap(observation => observation.spoken)
    expect(foundReceipt, receiptPhrases.join(' | ')).toBe(true)
  } catch (error) {
    // Read-only official VO diagnostics distinguish native keyboard focus from
    // the emulated DOM focus. Preserve the failure before diagnostic speech.
    const diagnostics: Record<string, unknown> = { failure: String(error), observations: [...observations] }
    try {
      diagnostics.domFocus = await page.evaluate(() => ({
        documentHasFocus: document.hasFocus(),
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
        name: document.activeElement?.getAttribute('aria-label'),
      }))
      diagnostics.spokenPhraseLog = [...await voiceOver.spokenPhraseLog()]
      diagnostics.itemTextLog = [...await voiceOver.itemTextLog()]
      diagnostics.keyboardFocus = await capture('diagnose keyboard focus', () => voiceOver.perform(voiceOver.keyboardCommands.describeItemWithKeyboardFocus, { capture: true }))
      diagnostics.window = await capture('diagnose window', () => voiceOver.perform(voiceOver.keyboardCommands.hearWindowSummary, { capture: true }))
    } catch (diagnosticError) {
      diagnostics.diagnosticError = String(diagnosticError)
    }
    await testInfo.attach('voiceover-native-focus-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    throw error
  }
})


test('real VoiceOver identifies Opportunities and Settings primary-route semantics', async ({ page, voiceOver }) => {
  await prepareJourney(page)

  await page.goto('/pjsdas/opportunities')
  await expect(page.getByRole('heading', { name: /岗位库|Job library/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /合成机会科技|AI产品经理/ })).toBeVisible()

  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const opportunityPhrases: string[] = []
  let foundOpportunityContext = false
  for (let i = 0; i < 32 && !foundOpportunityContext; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    opportunityPhrases.push(`${spoken} / ${item}`)
    foundOpportunityContext = /合成机会科技|AI产品经理|哪些在推进/.test(`${spoken} ${item}`)
  }
  expect(foundOpportunityContext, opportunityPhrases.join(' | ')).toBe(true)

  const opportunityButton = page.getByRole('button', { name: /合成机会科技|AI产品经理/ })
  await opportunityButton.click()
  const detail = page.locator('.job-detail-page')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('合成机会科技')
  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const detailPhrases: string[] = []
  let foundDetailSemantics = false
  for (let i = 0; i < 36 && !foundDetailSemantics; i += 1) {
    await voiceOver.next()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    detailPhrases.push(`${spoken} / ${item}`)
    foundDetailSemantics = /结论|继续推进当前流程|阶段|面试|流程结果|进展与行动/.test(`${spoken} ${item}`)
  }
  expect(foundDetailSemantics, detailPhrases.join(' | ')).toBe(true)

  await page.goto('/pjsdas/settings')
  const settingsHeading = page.getByRole('heading', { name: /^(设置|Settings)$/i })
  await expect(settingsHeading).toBeVisible()
  await page.bringToFront()
  await page.locator('.tsui-brand').focus()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const settingsPhrases: string[] = []
  let foundSettings = false
  for (let i = 0; i < 32 && !foundSettings; i += 1) {
    await voiceOver.nextHeading()
    const spoken = await voiceOver.lastSpokenPhrase()
    const item = await voiceOver.itemText()
    settingsPhrases.push(`${spoken} / ${item}`)
    foundSettings = /设置|Settings/i.test(`${spoken} ${item}`)
  }
  expect(foundSettings, settingsPhrases.join(' | ')).toBe(true)

  await expect(page.getByRole('button', { name: /立即同步|Sync now/ })).toHaveCount(0)
  await page.getByLabel(/管理账号与同步|Manage account and sync/).click()
  await expect(page.getByRole('button', { name: /立即同步|Sync now/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /退出 TodayAction|Sign out/ })).toBeVisible()
})


test('real VoiceOver finds a dated schedule node and its occurrence detail', async ({ page, voiceOver }) => {
  await prepareJourney(page)
  await page.goto('/pjsdas/schedule')
  await expect(page.getByRole('heading', { name: /^(日程|Schedule)$/ })).toBeVisible()
  const node = page.locator('.tsui-schedule-row').filter({ hasText: '合成机会科技' })
  await expect(node).toHaveCount(1)
  // Use the focused web control directly. The OS-wide Item Chooser can keep
  // a stale document from a previous test window and hang before web entry.
  await page.bringToFront()
  await node.focus()
  await expect(node).toBeFocused()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const nodePhrases: string[] = []
  for (let i = 0; i < 4; i += 1) {
    nodePhrases.push((await voiceOver.lastSpokenPhrase()) + ' / ' + (await voiceOver.itemText()))
    if (nodePhrases.join(' ').includes('合成机会科技') && nodePhrases.join(' ').includes('面试')) break
    await voiceOver.next()
  }
  expect(nodePhrases.join(' ')).toContain('合成机会科技')
  expect(nodePhrases.join(' ')).toContain('面试')

  await node.click()
  const detail = page.locator('.tsui-schedule-detail')
  await expect(detail).toContainText('合成机会科技')
  await expect(detail).toContainText('2026-10-20')
  await expect(detail).toBeFocused()
  await voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus)
  const detailPhrases: string[] = []
  let foundDetail = false
  for (let i = 0; i < 24 && !foundDetail; i += 1) {
    await voiceOver.nextHeading()
    const phrase = (await voiceOver.lastSpokenPhrase()) + ' / ' + (await voiceOver.itemText())
    detailPhrases.push(phrase)
    foundDetail = phrase.includes('面试')
  }
  expect(foundDetail, detailPhrases.join(' | ')).toBe(true)
})
