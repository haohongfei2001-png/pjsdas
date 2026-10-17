import type { WorkspaceSource, WorkspaceWriteInput } from '../../gateway/workspaceSource.js'

/** Rebuilt offline fixture. This is synthetic ledger output, never production
 * evidence or a substitute for the real transaction/concurrency SQL tests. */
export function discoveryReceiptFixture(input: WorkspaceWriteInput, revision: number,
  committedAt = '2026-10-07T20:00:00.000Z'): NonNullable<Awaited<ReturnType<NonNullable<WorkspaceSource['readCommandReceipt']>>>> | null {
  const command = input.command
  if (!command) return null
  if (!command.payloadHash || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Synthetic ledger requires an exact payload hash and committed revision')
  return {
    commandId: command.commandId, operation: command.operation, payloadHash: command.payloadHash, resultingRevision: revision,
    receipt: { receiptId: `command-receipt:${command.commandId}`, commandId: command.commandId, operation: command.operation,
      status: 'COMMITTED', revision, committedAt },
  }
}

interface SyntheticPosting {
  company: string; role: string; sourceUrl: string; sourceTitle?: string; location?: string
  deadline?: string; recruitmentBatch?: string; publishedAt?: string; description?: string
}
function html(value: string) { return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)) }

/** Exact synthetic pages only. Unknown URLs return 404; this never delegates
 * to global fetch, resolves a real host or asserts an employer relationship. */
export function recruitingPagesFixture(postings: SyntheticPosting[]): typeof fetch {
  const pages = new Map(postings.map(item => [new URL(item.sourceUrl).href, structuredClone(item)]))
  return async input => {
    const url = new URL(input instanceof Request ? input.url : String(input)).href
    const item = pages.get(url)
    if (!item) return new Response('Synthetic page absent', { status: 404 })
    const labels = [['公司名称', item.company], ['申请截止日期', item.deadline], ['招聘批次', item.recruitmentBatch]]
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join('')
    const job = { '@context': 'https://schema.org', '@type': 'JobPosting', url: item.sourceUrl,
      title: item.role, hiringOrganization: { '@type': 'Organization', name: item.company },
      ...(item.location ? { jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: item.location } } } : {}),
      ...(item.publishedAt ? { datePosted: item.publishedAt } : {}),
      ...(item.description ? { description: item.description } : {}),
    }
    const json = JSON.stringify(job).replace(/</g, '\\u003c')
    return new Response(`<!doctype html><html><head><title>${html(item.role)} - ${html(item.company)}</title><script type="application/ld+json">${json}</script></head><body><main><article><h1>${html(item.role)}</h1><dl>${labels}</dl><p>${html(item.description ?? '')}</p></article></main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}

/** Gateway/domain happy-path evidence produced by the real verifier against
 * an offline exact posting page. Security negatives must use independent
 * source documents rather than deriving them from candidate input. */
export async function verifiedPostingFixture(posting: SyntheticPosting, verifiedAt: string) {
  const { verifyDiscoverySourceObservation } = await import('../../gateway/discoverySourceVerifier.js')
  const value = await verifyDiscoverySourceObservation({ sourceRecordId: 'synthetic-candidate', company: posting.company, role: posting.role,
    sourceUrl: posting.sourceUrl, sourceTitle: posting.sourceTitle ?? posting.role, discoveredAt: verifiedAt },
    { fetchImpl: recruitingPagesFixture([posting]), now: new Date(verifiedAt) })
  if (value.sourceVerification !== 'verified' || !value.sourceProof) throw new Error(`Synthetic source fixture did not verify: ${value.sourceVerificationReason}`)
  return value
}
