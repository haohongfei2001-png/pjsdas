import { assertChangeSetValid, type ChangeSetRecord } from '../changeSet.js'
import { createDiscoveryRunRecord, validateDiscoveryRunRecord } from '../discoveryRun.js'

export const MCP_PROPOSAL_VERSION = 1 as const
export const MCP_PROPOSAL_FRAGMENT_KEY = 'pjsdas-proposal'
export const PJSDAS_REVIEW_BASE_URL = 'https://haohongfei2001-png.github.io/pjsdas/'
export const MCP_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000

export interface McpDiscoveryReviewItem {
  company: string
  role: string
  reason?: string
  reasons?: string[]
  qualityScore?: number
}

export interface McpDiscoveryReview {
  received: number
  accepted: number
  duplicateCount: number
  rejectedCount: number
  deferredCount: number
  skippedDuplicates: McpDiscoveryReviewItem[]
  rejectedCandidates: McpDiscoveryReviewItem[]
  deferredCandidates: McpDiscoveryReviewItem[]
}

export interface McpProposalEnvelope {
  version: typeof MCP_PROPOSAL_VERSION
  workspaceVersion?: string
  expiresAt: string
  changeSet: ChangeSetRecord
  discoveryReview?: McpDiscoveryReview
}

function bytesToBinary(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return binary
}

function binaryToBytes(binary: string) {
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toBase64Url(value: string) {
  const binary = bytesToBinary(new TextEncoder().encode(value))
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const bytes = binaryToBytes(atob(padded))
  return new TextDecoder().decode(bytes)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validIso(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
}

function validateDiscoveryReview(value: unknown): asserts value is McpDiscoveryReview {
  if (!isObject(value)) throw new Error('PJSDAS discovery review metadata is invalid.')
  for (const key of ['received', 'accepted', 'duplicateCount', 'rejectedCount', 'deferredCount'] as const) {
    const count = value[key]
    if (!Number.isInteger(count) || Number(count) < 0 || Number(count) > 20) {
      throw new Error(`PJSDAS discovery review ${key} is invalid.`)
    }
  }
  for (const key of ['skippedDuplicates', 'rejectedCandidates', 'deferredCandidates'] as const) {
    const items = value[key]
    if (!Array.isArray(items) || items.length > 20) throw new Error(`PJSDAS discovery review ${key} is invalid.`)
    for (const item of items) {
      if (!isObject(item) || typeof item.company !== 'string' || !item.company.trim() || typeof item.role !== 'string' || !item.role.trim()) {
        throw new Error(`PJSDAS discovery review ${key} contains an invalid candidate.`)
      }
      if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 1000)) throw new Error('PJSDAS discovery review reason is invalid.')
      if (item.reasons !== undefined && (!Array.isArray(item.reasons) || item.reasons.length > 10 || item.reasons.some((reason) => typeof reason !== 'string' || reason.length > 1000))) throw new Error('PJSDAS discovery review reasons are invalid.')
      if (item.qualityScore !== undefined && (typeof item.qualityScore !== 'number' || item.qualityScore < 0 || item.qualityScore > 100)) throw new Error('PJSDAS discovery review quality score is invalid.')
    }
  }
}

function validateDiscoveryRunMetadata(changeSet: ChangeSetRecord) {
  if (!changeSet.discoveryRun) return
  const errors = validateDiscoveryRunRecord(changeSet.discoveryRun)
  if (errors.length) throw new Error(`PJSDAS Discovery Run metadata is invalid: ${errors[0]}`)
}

function withDiscoveryRun(
  changeSet: ChangeSetRecord,
  workspaceVersion: string | undefined,
  now: Date,
  discoveryReview?: McpDiscoveryReview,
) {
  if (changeSet.discoveryRun) return changeSet
  if (!discoveryReview) return changeSet
  const sourceUrls = changeSet.operations.flatMap((operation) =>
    operation.kind === 'add_discovered_opportunity'
      ? [operation.opportunity.detail?.discovery?.sourceUrl].filter((value): value is string => Boolean(value))
      : []
  )
  if (!sourceUrls.length) return changeSet
  return {
    ...changeSet,
    discoveryRun: createDiscoveryRunRecord({
      screening: discoveryReview,
      candidateSourceUrls: sourceUrls,
      workspaceVersion,
      defaultMode: 'ad_hoc',
      completedAt: now.toISOString(),
    }),
  }
}

export function createMcpProposalEnvelope(
  changeSet: ChangeSetRecord,
  workspaceVersion?: string,
  now = new Date(),
  discoveryReview?: McpDiscoveryReview,
): McpProposalEnvelope {
  const enrichedChangeSet = withDiscoveryRun(changeSet, workspaceVersion, now, discoveryReview)
  assertChangeSetValid(enrichedChangeSet)
  validateDiscoveryRunMetadata(enrichedChangeSet)
  if (discoveryReview) validateDiscoveryReview(discoveryReview)
  return {
    version: MCP_PROPOSAL_VERSION,
    workspaceVersion,
    expiresAt: new Date(now.getTime() + MCP_PROPOSAL_TTL_MS).toISOString(),
    changeSet: enrichedChangeSet,
    discoveryReview,
  }
}

export function encodeMcpProposal(envelope: McpProposalEnvelope) {
  assertChangeSetValid(envelope.changeSet)
  validateDiscoveryRunMetadata(envelope.changeSet)
  if (envelope.version !== MCP_PROPOSAL_VERSION) throw new Error('Unsupported PJSDAS proposal version.')
  if (!validIso(envelope.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')
  if (envelope.discoveryReview) validateDiscoveryReview(envelope.discoveryReview)
  return toBase64Url(JSON.stringify(envelope))
}

export function decodeMcpProposal(encoded: string): McpProposalEnvelope {
  if (!encoded || encoded.length > 24_000) throw new Error('PJSDAS proposal link is invalid or too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(encoded))
  } catch {
    throw new Error('PJSDAS proposal link could not be decoded.')
  }
  if (!isObject(parsed) || parsed.version !== MCP_PROPOSAL_VERSION || !('changeSet' in parsed)) {
    throw new Error('PJSDAS proposal envelope is invalid.')
  }
  if (parsed.workspaceVersion !== undefined && typeof parsed.workspaceVersion !== 'string') {
    throw new Error('PJSDAS proposal workspace version is invalid.')
  }
  if (!validIso(parsed.expiresAt)) throw new Error('PJSDAS proposal expiry is invalid.')
  if (parsed.discoveryReview !== undefined) validateDiscoveryReview(parsed.discoveryReview)
  assertChangeSetValid(parsed.changeSet)
  validateDiscoveryRunMetadata(parsed.changeSet as ChangeSetRecord)
  return parsed as unknown as McpProposalEnvelope
}

export function buildMcpProposalReviewUrl(
  signedToken: string,
  baseUrl = PJSDAS_REVIEW_BASE_URL,
) {
  if (!signedToken || signedToken.length > 32_000) throw new Error('PJSDAS proposal token is invalid or too large.')
  return `${baseUrl}#${MCP_PROPOSAL_FRAGMENT_KEY}=${signedToken}`
}

export function encodedProposalFromHash(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return params.get(MCP_PROPOSAL_FRAGMENT_KEY)
}

export function removeProposalFromUrl(url: URL) {
  const params = new URLSearchParams(url.hash.replace(/^#/, ''))
  if (!params.has(MCP_PROPOSAL_FRAGMENT_KEY)) return url
  params.delete(MCP_PROPOSAL_FRAGMENT_KEY)
  url.hash = params.toString() ? `#${params.toString()}` : ''
  return url
}