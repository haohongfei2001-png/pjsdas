import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSnapshot, type PJSDASSnapshot } from '../src/snapshot.js'
import type { BridgeReadContext } from '../src/ai/readLayer.js'

export interface GatewayWorkspace {
  snapshot: PJSDASSnapshot
  context: BridgeReadContext
}

export interface WorkspaceWriteInput {
  snapshot: PJSDASSnapshot
  /** Exact read baseline. Autonomous writers must fail closed if the workspace moved. */
  expectedWorkspaceVersion?: string
  updatedByDevice?: string
}

export interface WorkspaceSource {
  read(): Promise<GatewayWorkspace>
  /** Optional: only authenticated durable sources expose autonomous writes. */
  write?(input: WorkspaceWriteInput): Promise<GatewayWorkspace>
}

export function requireWritableWorkspaceSource(source: WorkspaceSource) {
  if (!source.write) {
    throw new WorkspaceSourceError(
      'WORKSPACE_READ_ONLY',
      'This PJSDAS workspace source is read-only and cannot accept autonomous ingestion.',
      false,
    )
  }
  return source as WorkspaceSource & { write(input: WorkspaceWriteInput): Promise<GatewayWorkspace> }
}

export class WorkspaceSourceError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'WorkspaceSourceError'
    this.code = code
    this.retryable = retryable
  }
}

export interface FileWorkspaceSourceOptions {
  file?: string | URL
  timezone?: string
  now?: Date
  workspaceVersion?: string
  defaultAvailableMinutes?: number
}

const DEFAULT_DEMO_FILE = new URL('./fixtures/demo-workspace.json', import.meta.url)

function resolveFile(file: string | URL | undefined) {
  if (!file) return fileURLToPath(DEFAULT_DEMO_FILE)
  if (file instanceof URL) return fileURLToPath(file)
  return resolve(process.cwd(), file)
}

function assertNow(value: Date | undefined) {
  if (!value) return undefined
  if (Number.isNaN(value.getTime())) throw new Error('PJSDAS_MCP_NOW is not a valid date.')
  return value
}

export function createFileWorkspaceSource(options: FileWorkspaceSourceOptions = {}): WorkspaceSource {
  const file = resolveFile(options.file)
  const now = assertNow(options.now)

  return {
    async read() {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'))
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught)
        throw new Error(`Unable to read PJSDAS MCP snapshot: ${message}`)
      }

      validateSnapshot(parsed)
      return {
        snapshot: parsed,
        context: {
          now: now ? new Date(now) : new Date(),
          timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
          workspaceVersion: options.workspaceVersion,
          defaultAvailableMinutes: options.defaultAvailableMinutes,
        },
      }
    },
  }
}

export function createEnvWorkspaceSource(): WorkspaceSource {
  const nowRaw = process.env.PJSDAS_MCP_NOW?.trim()
  const minutesRaw = process.env.PJSDAS_MCP_DEFAULT_AVAILABLE_MINUTES?.trim()
  const defaultAvailableMinutes = minutesRaw ? Number(minutesRaw) : undefined
  if (minutesRaw && (!Number.isFinite(defaultAvailableMinutes) || defaultAvailableMinutes! < 30 || defaultAvailableMinutes! > 1440)) {
    throw new Error('PJSDAS_MCP_DEFAULT_AVAILABLE_MINUTES must be between 30 and 1440.')
  }

  return createFileWorkspaceSource({
    file: process.env.PJSDAS_MCP_SNAPSHOT_FILE?.trim() || undefined,
    timezone: process.env.PJSDAS_MCP_TIMEZONE?.trim() || undefined,
    now: nowRaw ? new Date(nowRaw) : undefined,
    workspaceVersion: process.env.PJSDAS_MCP_WORKSPACE_VERSION?.trim() || undefined,
    defaultAvailableMinutes,
  })
}
