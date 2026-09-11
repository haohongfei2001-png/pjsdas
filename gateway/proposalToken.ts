import {
  createMcpProposalEnvelope,
  decodeMcpProposal,
  encodeMcpProposal,
  type McpDiscoveryReview,
  type McpProposalEnvelope,
} from '../src/ai/mcpProposal.js'
import type { ChangeSetRecord } from '../src/changeSet.js'

const SIGNING_CONTEXT = 'pjsdas-proposal-signing-v1:'

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function signingKey(secret: string) {
  if (!secret.trim()) throw new Error('PJSDAS proposal signing key is not configured.')
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${SIGNING_CONTEXT}${secret}`))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function createSignedProposalToken(
  changeSet: ChangeSetRecord,
  workspaceVersion: string | undefined,
  secret: string,
  now = new Date(),
  discoveryReview?: McpDiscoveryReview,
) {
  const envelope = createMcpProposalEnvelope(changeSet, workspaceVersion, now, discoveryReview)
  const encoded = encodeMcpProposal(envelope)
  const key = await signingKey(secret)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded))
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export async function verifySignedProposalToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<McpProposalEnvelope> {
  if (!token || token.length > 32_000) throw new Error('PJSDAS proposal token is invalid or too large.')
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) throw new Error('PJSDAS proposal token is malformed.')
  const encoded = token.slice(0, separator)
  const signature = base64UrlToBytes(token.slice(separator + 1))
  const key = await signingKey(secret)
  const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(encoded))
  if (!valid) throw new Error('PJSDAS proposal signature is invalid.')

  const envelope = decodeMcpProposal(encoded)
  const expiresAt = new Date(envelope.expiresAt)
  if (expiresAt.getTime() <= now.getTime()) throw new Error('PJSDAS proposal link has expired. Ask ChatGPT to create a new proposal.')
  return envelope
}
