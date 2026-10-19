import { describe, expect, it } from 'vitest'
import { namedVoiceOverItem } from '../e2e/support/voiceoverItemText.js'

const inputName = '要告诉 TodayAction 的内容'
const placeholder = '说说你的任务或日程…'
const value = '事项：填写报销单'
const empty = { value: '', placeholder }
const filled = { value, placeholder }

describe('native VoiceOver cursor item identity', () => {
  it.each([
    ['TodayAction，今天 button, group', 'TodayAction，今天'],
    ['＋ 告诉 TodayAction collapsed button', '＋ 告诉 TodayAction'],
    ['＋ 告诉 TodayAction expanded button', '＋ 告诉 TodayAction'],
    ['确认并保存 button', '确认并保存'],
  ])('matches the exact button name and native role: %s', (item, name) => {
    expect(namedVoiceOverItem(item, name, 'button')).toBe(true)
  })

  it.each([
    [`${inputName} edit text`, empty],
    // Exact macOS artifact 12165457520, retry 1, after native opener activation.
    ['要告诉 TodayAction 的内容 说说你的任务或日程… 要告诉 TodayAction 的内容 edit text', empty],
    [`${inputName} ${inputName} edit text`, empty],
    [`${inputName} ${placeholder} text entry area, group`, empty],
    [`${inputName} ${value} ${inputName} edit text`, filled],
    [`${inputName} ${value} multi-line edit text`, filled],
    [`${inputName} ${value} ${placeholder} ${inputName} edit text`, filled],
    [`${inputName} ${placeholder} ${value} ${inputName} edit text`, filled],
    [`${inputName}, text field`, empty],
  ] as const)('matches only current textbox metadata and the full label: %s', (item, metadata) => {
    expect(namedVoiceOverItem(item, inputName, 'textbox', metadata)).toBe(true)
  })

  it.each([
    `${inputName}另一个 edit text`,
    `其他${inputName} edit text`,
    `${inputName} 其他 edit text`,
    `${inputName}另一个 ${placeholder} ${inputName} edit text`,
    `${inputName} ${placeholder} ${inputName}另一个 edit text`,
    `${inputName} 未知占位文字 ${inputName} edit text`,
    `${inputName} ${value} ${inputName} edit text`, // stale value is not current
    `${inputName} ${placeholder} ${inputName} button`,
    `${inputName} ${placeholder} ${inputName} dialog`,
    `${inputName} ${placeholder} ${inputName}`, // a name without role is not identity
    `${inputName} edit text button`,
    `${inputName} edit text unrelated metadata`,
    `其他输入 ${inputName} edit text`, // target name only in another field's value
    `告诉 TodayAction dialog`,
    `＋ 告诉 TodayAction button`,
  ])('rejects similar names, unknown content and wrong roles: %s', item => {
    expect(namedVoiceOverItem(item, inputName, 'textbox', empty)).toBe(false)
  })

  it.each([
    '确认并保存另一个事项 button',
    '确认并保存 其他 button',
    '确认并保存 edit text',
    '确认并保存',
    '确认并保存 button edit text',
  ])('does not weaken the save button identity: %s', item => {
    expect(namedVoiceOverItem(item, '确认并保存', 'button')).toBe(false)
  })

  it('does not accept target words only inside a different textbox value', () => {
    expect(namedVoiceOverItem(`其他输入 ${inputName} edit text`, inputName, 'textbox', { value: inputName, placeholder: '' })).toBe(false)
  })
})
