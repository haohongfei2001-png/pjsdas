import { beforeEach, describe, expect, it, vi } from 'vitest'
const network = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }))
vi.mock('../src/backendEndpoints.js', () => ({ fetchBackend: network.fetch }))
vi.mock('../src/cloud/cloudClient.js', () => ({ getAccountAccessToken: network.token }))
import { fetchConnectedRemoteWorkspace } from '../src/cloud/connectedWorkspaceRepository.js'
import { setAccountCacheSession, AccountCacheChangedError } from '../src/cloud/accountCacheLease.js'
import { createSnapshot } from '../src/snapshot.js'
const snapshot = createSnapshot({ opportunities: [], actions: [], processes: [], processEvents: [], prep: [], applicationGroups: [], timeline: [] })
const response = (revision: number) => Response.json({ workspaceId: 'synthetic-workspace', revision, schemaVersion: snapshot.version, snapshot })
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { resolve, reject, promise } }
const passive = (account = 'A') => fetchConnectedRemoteWorkspace(account, undefined, { passive: true })
beforeEach(() => { network.fetch.mockReset(); network.token.mockReset().mockImplementation(async account => `synthetic:${account}`); setAccountCacheSession(undefined); setAccountCacheSession('A') })
describe('short-lived account/session-bound passive read sharing', () => {
  it('coalesces concurrent passive readers and returns separate snapshots', async () => {
    const pending = deferred<Response>(); network.fetch.mockReturnValue(pending.promise)
    const one = passive(), two = passive(), three = passive()
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1))
    pending.resolve(response(1)); const results = await Promise.all([one, two, three])
    expect(results.map(item => item.version)).toEqual(['txn:1', 'txn:1', 'txn:1'])
    results[0].snapshot.data.opportunities.push({ id: 'mutated-consumer-copy' } as any)
    expect(results[1].snapshot.data.opportunities).toEqual([])
    network.fetch.mockResolvedValue(response(2)); expect((await passive()).version).toBe('txn:2')
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })
  it('does not combine different accounts', async () => {
    const pendingA = deferred<Response>(), pendingB = deferred<Response>()
    network.fetch.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise)
    const a = passive('A'), b = passive('B')
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2))
    const headers = network.fetch.mock.calls.map(call => call[1].headers.authorization)
    expect(headers).toEqual(['Bearer synthetic:A', 'Bearer synthetic:B'])
    pendingA.resolve(response(1)); pendingB.resolve(response(2)); expect((await Promise.all([a, b])).map(item => item.version)).toEqual(['txn:1', 'txn:2'])
  })
  it('same account with a new session sends a new request and rejects the old response', async () => {
    let token = 'old-session'; network.token.mockImplementation(async () => token)
    const old = deferred<Response>(), fresh = deferred<Response>(); network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = passive(); const firstRejected = expect(first).rejects.toBeInstanceOf(AccountCacheChangedError)
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1)); token = 'new-session'
    const second = passive(); await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2))
    fresh.resolve(response(2)); expect((await second).version).toBe('txn:2')
    old.resolve(response(1)); await firstRejected
  })
  it('logout invalidates the old response even if a token provider returns the same string', async () => {
    const pending = deferred<Response>(); network.fetch.mockReturnValue(pending.promise)
    const request = passive(), rejected = expect(request).rejects.toBeInstanceOf(AccountCacheChangedError)
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1)); setAccountCacheSession(undefined); setAccountCacheSession('A')
    pending.resolve(response(1)); await rejected
  })
  it('a forced command refresh bypasses a pending passive read and its old finally cannot remove the new request', async () => {
    const old = deferred<Response>(), fresh = deferred<Response>(); network.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = passive(), rejected = expect(first).rejects.toBeInstanceOf(AccountCacheChangedError)
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1))
    const forced = fetchConnectedRemoteWorkspace('A'); await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2))
    old.resolve(response(1)); await rejected
    const concurrent = passive(); await Promise.resolve(); await Promise.resolve()
    expect(network.fetch).toHaveBeenCalledTimes(2)
    fresh.resolve(response(2)); expect((await Promise.all([forced, concurrent])).map(item => item.version)).toEqual(['txn:2', 'txn:2'])
  })
  it('a newer forced read starting during the final session check invalidates the earlier response', async () => {
    const finalToken = deferred<string>(); let calls = 0
    network.token.mockImplementation(async () => ++calls === 2 ? finalToken.promise : 'synthetic:A')
    network.fetch.mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(2))
    const first = passive(), rejected = expect(first).rejects.toBeInstanceOf(AccountCacheChangedError)
    await vi.waitFor(() => expect(network.token).toHaveBeenCalledTimes(2))
    const second = fetchConnectedRemoteWorkspace('A'); expect((await second).version).toBe('txn:2')
    finalToken.resolve('synthetic:A'); await rejected
  })
  it('cleans up failed requests so the next current passive read can retry', async () => {
    network.fetch.mockRejectedValueOnce(new Error('synthetic offline')).mockResolvedValueOnce(response(2))
    await expect(passive()).rejects.toThrow('synthetic offline')
    expect((await passive()).version).toBe('txn:2'); expect(network.fetch).toHaveBeenCalledTimes(2)
  })
  it('does not start a request when logout occurs during token lookup', async () => {
    const token = deferred<string>(); network.token.mockReturnValue(token.promise)
    const pending = passive(), rejected = expect(pending).rejects.toBeInstanceOf(AccountCacheChangedError)
    setAccountCacheSession(undefined); token.resolve('synthetic:A'); await rejected
    expect(network.fetch).not.toHaveBeenCalled()
  })
})
