/**
 * Candidate byte protocol, used only by the default-off staged adapter. NOT a
 * SQL authority, resource quota, or migration. Reconstructed bytes require the original family
 * guard under its original locks, then ONE atomic business commit.
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const protocol = 'workspace-staged-documents-v1' as const
export const stagedDocumentFragmentBytes = 65_536
export const stagedDocumentNames = ['metadata', 'beforeEnvelope', 'afterEnvelope', 'compensation'] as const
export type StagedDocumentName = typeof stagedDocumentNames[number]
type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uint = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw Error(code) }
const wireClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface StagedRequestBinding {
  stageId: string
  family: string
  userId: string
  workspaceId: string
  expectedEpoch: string
  expectedRevision: number
  commandId: string
  payloadHash: string
  operation: string
  principal: string
  /** Original out-of-band grant/lease/preview arguments, NOT a cached decision. */
  authority: JsonObject
}
export interface StagedDocumentDescriptor { name: StagedDocumentName; bytes: number; sha256: string }
export interface StagedDocumentManifest {
  protocol: typeof protocol
  binding: StagedRequestBinding
  effects: { protocol: 'workspace-effect-chain-v1'; count: number; sha256: string }
  documents: StagedDocumentDescriptor[]
  sha256: string
}
export interface StagedDocumentFragment {
  stageId: string
  manifestSha256: string
  document: StagedDocumentName
  offset: number
  base64: string
}
export interface StagedDocumentUploadStatus {
  stageId: string
  manifestSha256: string
  completed: boolean
  nextOffsets: Record<StagedDocumentName, number>
}
export interface StagedDocumentTransport {
  begin(input: { manifestWire: string; manifestSha256: string }, signal: AbortSignal): Promise<StagedDocumentUploadStatus>
  append(fragment: StagedDocumentFragment, signal: AbortSignal): Promise<{ stageId: string; manifestSha256: string; document: StagedDocumentName; nextOffset: number }>
}

function checkBinding(binding: StagedRequestBinding) {
  requireValue(object(binding), 'INVALID_STAGE_BINDING')
  for (const name of ['stageId', 'family', 'userId', 'workspaceId', 'expectedEpoch', 'commandId', 'operation', 'principal'] as const) {
    requireValue(typeof binding[name] === 'string' && binding[name].trim().length > 0, 'INVALID_STAGE_BINDING')
  }
  requireValue(uint(binding.expectedRevision) && hex(binding.payloadHash) && object(binding.authority), 'INVALID_STAGE_BINDING')
}
function checkRequestBinding(request: JsonObject, binding: StagedRequestBinding) {
  for (const name of ['userId', 'workspaceId', 'expectedEpoch', 'expectedRevision', 'commandId', 'payloadHash', 'operation', 'principal'] as const) {
    requireValue(request[name] === binding[name], 'REQUEST_STAGE_BINDING_MISMATCH')
  }
}
// The version fixes this serialization order. Byte identity, not JSONB's text
// representation, determines transport hashes. No JSON pretty-printing.
function manifestDigest(manifest: Omit<StagedDocumentManifest, 'sha256'>) {
  return sha(JSON.stringify({ protocol: manifest.protocol, binding: manifest.binding, effects: manifest.effects, documents: manifest.documents }))
}

/** Send this exact wire as a text argument to SQL; never hash JSONB::text,
 * whose ordering/whitespace are not the original UTF-8 transport bytes. */
export function parseStagedDocumentManifest(wire: string, digest: string): StagedDocumentManifest {
  requireValue(typeof wire === 'string' && hex(digest) && sha(wire) === digest, 'MANIFEST_DIGEST_MISMATCH')
  const value: unknown = JSON.parse(wire)
  requireValue(object(value) && Object.keys(value).length === 4
    && ['protocol', 'binding', 'effects', 'documents'].every(key => Object.hasOwn(value, key)), 'INVALID_MANIFEST_WIRE')
  return { ...value, sha256: digest } as unknown as StagedDocumentManifest
}

/** The caller removes only `changes`, which has its separately bound effect
 * chain. ALL other request fields survive, including V5 projectionDelta,
 * historical/forward-compatible metadata, raw headers and original Undo. */
export function prepareStagedRequestDocuments(
  request: JsonObject,
  binding: StagedRequestBinding,
  effects: StagedDocumentManifest['effects'],
) {
  checkBinding(binding)
  requireValue(object(request) && !Object.hasOwn(request, 'changes'), 'EFFECTS_REQUIRE_SEPARATE_BOUND_STREAM')
  checkRequestBinding(request, binding)
  requireValue(effects.protocol === 'workspace-effect-chain-v1' && uint(effects.count) && hex(effects.sha256), 'INVALID_EFFECT_BINDING')
  requireValue(object(request.beforeEnvelope) && object(request.afterEnvelope) && Object.hasOwn(request, 'compensation'), 'MISSING_STAGED_DOCUMENT')
  const { beforeEnvelope, afterEnvelope, compensation, ...metadata } = request
  const values = { metadata, beforeEnvelope, afterEnvelope, compensation }
  const bytes = new Map<StagedDocumentName, Buffer>()
  const documents = stagedDocumentNames.map(name => {
    const wire = JSON.stringify(values[name])
    requireValue(typeof wire === 'string', 'INVALID_DOCUMENT_JSON')
    const value = Buffer.from(wire, 'utf8'); bytes.set(name, value)
    return { name, bytes: value.length, sha256: sha(value) }
  })
  const unsigned = { protocol, binding: wireClone(binding), effects: wireClone(effects), documents }
  const manifest: StagedDocumentManifest = { ...unsigned, sha256: manifestDigest(unsigned) }
  const totalBytes = documents.reduce((sum, doc) => sum + doc.bytes, 0)
  requireValue(uint(totalBytes), 'INVALID_TOTAL_BYTES')
  return {
    // Return detached values; later caller mutation cannot rewrite staged bytes.
    manifest: wireClone(manifest), manifestWire: JSON.stringify(unsigned), totalBytes,
    *fragments(): Generator<StagedDocumentFragment> {
      for (const name of stagedDocumentNames) {
        const value = bytes.get(name)!
        for (let offset = 0; offset < value.length; offset += stagedDocumentFragmentBytes) {
          yield { stageId: manifest.binding.stageId, manifestSha256: manifest.sha256, document: name, offset,
            base64: value.subarray(offset, offset + stagedDocumentFragmentBytes).toString('base64') }
        }
      }
    },
  }
}

/** Executable local receiver specification. Memory-backed, NOT a production
 * spool. Explicit reservedBytes represents prior resource admission; it is not
 * a new product cap. Durable reservation, expiry and cleanup are still gates. */
export function createStagedDocumentReceiver(input: {
  manifest: StagedDocumentManifest
  expectedBinding: StagedRequestBinding
  expectedEffects: StagedDocumentManifest['effects']
  reservedBytes: number
  signal: AbortSignal
}) {
  input.signal.throwIfAborted()
  const manifest = wireClone(input.manifest)
  checkBinding(manifest.binding)
  requireValue(manifest.protocol === protocol && isDeepStrictEqual(manifest.binding, input.expectedBinding)
    && isDeepStrictEqual(manifest.effects, input.expectedEffects), 'STAGE_CONTEXT_MISMATCH')
  requireValue(manifest.effects.protocol === 'workspace-effect-chain-v1' && uint(manifest.effects.count) && hex(manifest.effects.sha256), 'INVALID_EFFECT_BINDING')
  requireValue(Array.isArray(manifest.documents) && manifest.documents.length === stagedDocumentNames.length, 'INVALID_DOCUMENT_DIRECTORY')
  manifest.documents.forEach((doc, index) => requireValue(object(doc) && doc.name === stagedDocumentNames[index]
    && uint(doc.bytes) && doc.bytes > 0 && hex(doc.sha256), 'INVALID_DOCUMENT_DIRECTORY'))
  requireValue(hex(manifest.sha256) && manifest.sha256 === manifestDigest(manifest), 'MANIFEST_DIGEST_MISMATCH')
  const total = manifest.documents.reduce((sum, doc) => sum + doc.bytes, 0)
  requireValue(uint(total) && uint(input.reservedBytes) && input.reservedBytes >= total, 'STAGING_RESOURCE_RESERVATION_REQUIRED')
  const states = new Map(manifest.documents.map(doc => [doc.name, { descriptor: doc, offset: 0, parts: new Map<number, Buffer>() }]))
  let sealed = false
  return {
    /** Idempotent exact duplicate; no gaps, overlaps, cross-stage fragments,
     * altered duplicate bytes, character-based offsets or partial UTF-8 decode. */
    append(part: StagedDocumentFragment) {
      input.signal.throwIfAborted()
      requireValue(!sealed, 'STAGE_DOCUMENTS_SEALED')
      requireValue(object(part) && part.stageId === manifest.binding.stageId && part.manifestSha256 === manifest.sha256, 'FRAGMENT_CONTEXT_MISMATCH')
      const state = states.get(part.document)
      requireValue(state && uint(part.offset) && part.offset % stagedDocumentFragmentBytes === 0
        && typeof part.base64 === 'string' && part.base64.length <= 87_384, 'INVALID_DOCUMENT_FRAGMENT')
      const bytes = Buffer.from(part.base64, 'base64')
      const expectedLength = Math.min(stagedDocumentFragmentBytes, state.descriptor.bytes - part.offset)
      requireValue(bytes.toString('base64') === part.base64 && bytes.length > 0 && bytes.length === expectedLength, 'INVALID_DOCUMENT_FRAGMENT_BYTES')
      const prior = state.parts.get(part.offset)
      if (prior) {
        requireValue(prior.equals(bytes), 'CHANGED_REPEATED_DOCUMENT_FRAGMENT')
        return { document: part.document, nextOffset: state.offset }
      }
      requireValue(part.offset === state.offset, 'DOCUMENT_FRAGMENT_GAP')
      state.parts.set(part.offset, bytes); state.offset += bytes.length
      return { document: part.document, nextOffset: state.offset }
    },
    /** Returns no receipt and performs no mutation. The final SQL family guard
     * MUST re-authorize even a replay, preserving original lock order and CAS. */
    reconstructForFinalAuthorization(): JsonObject {
      input.signal.throwIfAborted()
      const values = new Map<StagedDocumentName, unknown>()
      for (const [name, state] of states) {
        requireValue(state.offset === state.descriptor.bytes, 'INCOMPLETE_STAGED_DOCUMENTS')
        const bytes = Buffer.concat([...state.parts.values()])
        requireValue(sha(bytes) === state.descriptor.sha256, 'STAGED_DOCUMENT_DIGEST_MISMATCH')
        // Fatal decoding: replacement characters must not hide split/invalid UTF-8.
        values.set(name, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      }
      const metadata = values.get('metadata'), beforeEnvelope = values.get('beforeEnvelope'), afterEnvelope = values.get('afterEnvelope')
      requireValue(object(metadata) && !['changes', 'beforeEnvelope', 'afterEnvelope', 'compensation'].some(key => Object.hasOwn(metadata, key))
        && object(beforeEnvelope) && object(afterEnvelope), 'INVALID_RECONSTRUCTED_DOCUMENTS')
      const request = { ...metadata, beforeEnvelope, afterEnvelope, compensation: values.get('compensation') }
      checkRequestBinding(request, manifest.binding)
      input.signal.throwIfAborted(); sealed = true
      return request
    },
  }
}

/** Upload only. This function cannot commit/replay a business command or expose
 * a cached receipt. After it returns, the caller must upload/verify effects and
 * enter the original final authorization transaction, EVEN if completed=true.
 * A failed/ambiguous upload resumes by calling begin with the SAME manifest;
 * there is no automatic retry, new stage/command ID, or per-page timeout reset. */
export async function uploadStagedRequestDocuments(input: {
  prepared: ReturnType<typeof prepareStagedRequestDocuments>
  transport: StagedDocumentTransport
  signal: AbortSignal
}) {
  const { prepared, transport, signal } = input
  const manifest = parseStagedDocumentManifest(prepared.manifestWire, prepared.manifest.sha256)
  signal.throwIfAborted()
  const status = await transport.begin({ manifestWire: prepared.manifestWire, manifestSha256: manifest.sha256 }, signal)
  signal.throwIfAborted()
  requireValue(object(status) && status.stageId === manifest.binding.stageId && status.manifestSha256 === manifest.sha256
    && typeof status.completed === 'boolean' && object(status.nextOffsets) && !Object.hasOwn(status, 'result') && !Object.hasOwn(status, 'receipt'), 'INVALID_UPLOAD_STATUS')
  for (const descriptor of manifest.documents) {
    const offset = status.nextOffsets[descriptor.name]
    requireValue(uint(offset) && offset <= descriptor.bytes && (offset === descriptor.bytes || offset % stagedDocumentFragmentBytes === 0)
      && (!status.completed || offset === descriptor.bytes), 'INVALID_UPLOAD_CURSOR')
  }
  const offsets = { ...status.nextOffsets }
  for (const fragment of prepared.fragments()) {
    signal.throwIfAborted()
    if (fragment.offset < offsets[fragment.document]) continue
    requireValue(fragment.offset === offsets[fragment.document], 'INVALID_UPLOAD_CURSOR')
    const ack = await transport.append(fragment, signal)
    signal.throwIfAborted()
    requireValue(object(ack) && ack.stageId === manifest.binding.stageId && ack.manifestSha256 === manifest.sha256
      && ack.document === fragment.document && ack.nextOffset === fragment.offset + Buffer.from(fragment.base64, 'base64').length, 'INVALID_UPLOAD_ACK')
    offsets[fragment.document] = ack.nextOffset
  }
  signal.throwIfAborted()
  return { stageId: manifest.binding.stageId, manifestSha256: manifest.sha256, requiresFinalAuthorization: true as const, previouslyCompleted: status.completed }
}
