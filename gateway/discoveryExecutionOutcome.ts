import { WorkspaceSourceError } from './workspaceSource.js'

/** Only a server-owned adapter with a definite provider response can assert a
 * known failure. A generic exception/timeout never proves no charge occurred. */
export class KnownDiscoverySearchFailure extends WorkspaceSourceError {}

/** Preserve the useful error code while preventing the worker from converting
 * a transport/reservation ambiguity into a repeatable settled failure. */
export class UncertainDiscoveryExecution extends WorkspaceSourceError {}
