export function localProcessEventDateTimeValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function occurredAtWhenOpeningProcessEventDraft(
  currentValue: string,
  userEdited: boolean,
  now = new Date(),
) {
  return userEdited ? currentValue : localProcessEventDateTimeValue(now)
}
