export type VoiceOverTextboxMetadata = { value: string; placeholder: string }

/** Match the native cursor description, not an assumed bare AX name. */
export function namedVoiceOverItem(
  item: string,
  name: string,
  role: 'button' | 'textbox',
  textbox?: VoiceOverTextboxMetadata,
): boolean {
  // Guidepup reads VoiceOver's `text under cursor`, which includes role and may
  // include the field's value/placeholder and repeat its accessible name.
  // Keep the role at the end and allow only known native role modifiers.
  const suffix = role === 'button'
    ? /(?:,?\s+)(?:(?:expanded|collapsed|dimmed)\s+)*button(?:,\s*group)?$/i
    : /(?:,?\s+)(?:(?:multi-line|multiline|read only|dimmed)\s+)*(?:edit text|text entry area|text field|text area|textbox)(?:,\s*(?:group|multi-line|multiline|read only|dimmed))*$/i
  const match = suffix.exec(item.trim())
  if (!match) return false
  const compact = (value: string) => value.replace(/\s+/g, '')
  const content = compact(item.trim().slice(0, match.index))
  const label = compact(name)
  if (!label) return false
  if (role === 'button') return content === label

  // Use only current metadata read from the exact DOM textbox. Do not accept
  // arbitrary text between the name and role, similar names, or wrong roles.
  const value = compact(textbox?.value ?? '')
  const placeholder = compact(textbox?.placeholder ?? '')
  const metadata = new Set(['', value, placeholder])
  if (value && placeholder) {
    metadata.add(value + placeholder)
    metadata.add(placeholder + value)
  }
  return [...metadata].some(text => content === label + text || content === label + text + label)
}
