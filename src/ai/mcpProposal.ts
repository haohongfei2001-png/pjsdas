import { assertChangeSetValid, type ChangeSetRecord } from '../changeSet.js'

export const MCP_PROPOSAL_VERSION = 1 as const
export const MCP_PROPOSAL_FRAGMENT_KEY = 'pjsdas-proposal'
export const PJSDAS_REVIEW_BASE_URL = 'https://haohongfei2001-png.github.io/pjsdas/'

export interface McpProposalEnvelope {
  version: typeof MCP_PROPOSAL_VERSION
  workspaceVersion?: string
  changeSet: ChangeSetRecord
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

export function encodeMcpProposal(envelope: McpProposalEnvelope) {
  assertChangeSetValid(envelope.changeSet)
  if (envelope.version !== MCP_PROPOSAL_VERSION) throw new Error('Unsupported PJSDAS proposal version.')
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
  assertChangeSetValid(parsed.changeSet)
  return parsed as unknown as McpProposalEnvelope
}

export function buildMcpProposalReviewUrl(
  changeSet: ChangeSetRecord,
  workspaceVersion?: string,
  baseUrl = PJSDAS_REVIEW_BASE_URL,
) {
  const encoded = encodeMcpProposal({
    version: MCP_PROPOSAL_VERSION,
    workspaceVersion,
    changeSet,
  })
  return `${baseUrl}#${MCP_PROPOSAL_FRAGMENT_KEY}=${encoded}`
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
