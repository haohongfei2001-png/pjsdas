export function resolveProductionBaseUrls(input: {
  canonicalApiOrigin?: string
  configuredOrigins: string
}) {
  const values = [
    input.canonicalApiOrigin,
    ...input.configuredOrigins.split(','),
  ]
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter((value, index, items) => items.indexOf(value) === index)
}
