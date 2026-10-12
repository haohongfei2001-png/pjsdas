/** A caller-owned, synchronous matching scope. No cross-message/user cache. */
export function createNotificationIdentityMatcher() {
  const regionsByText = new Map<string, readonly string[]>()
  return (text: string, alias: string): boolean => {
    let regions = regionsByText.get(text)
    if (regions === undefined) {
      // Preserve the original punctuation boundaries, Unicode tokens and case
      // normalization exactly; only avoid repeating this work for each alias.
      regions = text.toLowerCase().split(/[^\p{L}\p{N}\s]+/u)
        .map(region => (region.match(/[\p{L}\p{N}]+/gu) ?? []).join(' '))
      regionsByText.set(text, regions)
    }
    return regions.some(value => /^[a-z0-9 ]+$/i.test(alias)
      ? (` ${value} `).includes(` ${alias} `)
      : value.includes(alias))
  }
}
