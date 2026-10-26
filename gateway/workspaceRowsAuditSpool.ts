/** Private, request-local provisional bytes. Not durable intent or a product
 * quota: the existing complete-history materialization ceiling still applies. */
import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamVerifiedDocument, type VerifiedFragment } from './workspaceRowsLargeCommandPrototype.js'

export type WorkspaceRowsAuditAuthorization =
  | { userId: string; principal: 'first_party_web' }
  | { userId: string; principal: 'delegated_mcp'; family: 'opportunity_v3'; grantId: string; grantRevision: number; clientId: string }

export interface AuditDocument {
  protocol: 'workspace-audit-bytes-v1'
  workspaceId: string; userId: string; epoch: string; revision: number
  commandId: string; resultingRevision: number; totalBytes: number; sha256: string
}

/** Bound bytes BEFORE JSON parsing, including chunked / dishonest length
 * replies. The 65KiB decoded fragment fits below the existing 2MiB body cap. */
export async function boundedAuditResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw Error('AUDIT_RESPONSE_MISSING')
  const parts: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > 2_097_152) throw Error('AUDIT_RESPONSE_TOO_LARGE')
      parts.push(part.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock(); parts.length = 0 }
  }
}

export async function createAuditSpool() {
  const directory = await mkdtemp(join(tmpdir(), 'ta-audit-read-'))
  let file: FileHandle | undefined, verified = false, removed = false
  async function dispose() {
    verified = false
    try { await file?.close() } finally { file = undefined; await rm(directory, { recursive: true, force: true }); removed = true }
  }
  try { file = await open(join(directory, 'provisional'), 'wx+', 0o600) }
  catch (error) { await dispose(); throw error }
  return {
    async receive(document: AuditDocument, signal: AbortSignal, read: (offset: number) => Promise<VerifiedFragment>) {
      if (removed || verified) throw Error('AUDIT_SPOOL_STATE')
      return streamVerifiedDocument({ epoch: document.epoch, revision: document.revision, documentKey: document.commandId, signal,
        read: async offset => {
          const part = await read(offset)
          if (part.totalBytes !== document.totalBytes || part.sha256 !== document.sha256 || Buffer.from(part.base64, 'base64').length !== Math.min(65_536, document.totalBytes - offset)) throw Error('AUDIT_DESCRIPTOR_CHANGED')
          return part
        },
        // This only seals the private spool; the owning history operation MUST
        // perform its final authority/generation fence before materialization.
        fence: async () => true,
        sink: { write: async bytes => { let at = 0; while (at < bytes.length) { signal.throwIfAborted(); const n = await file!.write(bytes, at, bytes.length - at); if (!n.bytesWritten) throw Error('AUDIT_SPOOL_SHORT_WRITE'); at += n.bytesWritten } },
          commit: async () => { verified = true }, abort: dispose },
      })
    },
    async materialize(signal: AbortSignal): Promise<unknown> {
      if (!verified || removed || !file) throw Error('AUDIT_SPOOL_NOT_VERIFIED')
      signal.throwIfAborted()
      const bytes = await readFile(join(directory, 'provisional'), { signal })
      signal.throwIfAborted()
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    },
    dispose,
  }
}
