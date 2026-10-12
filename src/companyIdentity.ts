/** Closed employer-name variants, never arbitrary substring or fuzzy identity.
 * Bank-wide branding remains distinct from a named branch; callers must retain
 * all matching opportunities rather than choosing a branch. */
export function boundedCompanyNames(company: string): string[] {
  const names = [company]
  const bank = /^([\p{Script=Han}]{2,}银行)(?:股份有限公司)?(?:总行|[\p{Script=Han}]{2,8}分行)$/u.exec(company.trim())
  if (bank) names.push(bank[1]!)
  // A bilingual label can expose its contiguous Chinese brand. Only the
  // explicit country qualifier 中国 is removed; cities/branches are retained.
  if (/[a-z]/i.test(company)) {
    const chinese = company.match(/[\p{Script=Han}]{2,}/gu)
    if (chinese?.length === 1) {
      const latin = company.replace(chinese[0]!, '').trim()
      if (/^[a-z][a-z '&’.+-]{1,40}$/i.test(latin)) names.push(latin)
      names.push(chinese[0]!)
      if (chinese[0]!.endsWith('中国') && chinese[0]!.length >= 4) names.push(chinese[0]!.slice(0, -2))
    }
  }
  return [...new Set(names)]
}
