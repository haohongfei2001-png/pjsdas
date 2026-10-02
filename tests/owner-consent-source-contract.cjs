#!/usr/bin/env node
'use strict'

// Read-only, no-network source-contract regression harness.
// Usage: node tests/owner-consent-source-contract.cjs /path/to/repo
// This executes the actual TS/TSX source with a minimal deterministic hook driver.
// It does NOT replace React DOM, browser, BFCache, accessibility, or visual tests.
// All sessions, grant responses, requests, storage, and page events are synthetic.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createHash, webcrypto } = require('node:crypto')

const repo = path.resolve(process.argv[2] || process.cwd())
const repoRequire = createRequire(path.join(repo, 'package.json'))
const ts = repoRequire('typescript')
const OWNER = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000005'
const CLIENT = '00000000-0000-4000-8000-000000000002'
const GRANT = '00000000-0000-4000-8000-000000000003'
const files = [
  'src/aiAccess/OwnerManagementConsentPageHeavy.tsx',
  'src/aiAccess/ownerManagementConsentClient.ts',
  'src/aiAccess/ownerConsentPending.ts',
]
console.log('Actual source SHA-256:')
for (const file of files) {
  console.log(
    createHash('sha256')
      .update(fs.readFileSync(path.join(repo, file)))
      .digest('hex'),
    file,
  )
}

function makeEnvironment() {
  const data = new Map()
  const authListeners = new Set()
  const receipts = new Map()
  const env = {
    account: OWNER,
    reads: 0,
    writes: 0,
    posts: [],
    failSave: false,
    unknownFirst: false,
    grant: null,
    storage: {
      getItem(key) {
        return data.get(key) ?? null
      },
      setItem(key, value) {
        if (env.failSave) throw new Error('Synthetic storage quota failure')
        data.set(key, value)
      },
      removeItem(key) {
        data.delete(key)
      },
    },
    persistedValues() {
      return [...data.values()]
    },
    async switchAccount(account, event = account ? 'SIGNED_IN' : 'SIGNED_OUT') {
      env.account = account
      for (const listener of [...authListeners]) listener(event)
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
  env.auth = {
    async getSession() {
      return {
        data: {
          session: env.account
            ? {
                user: { id: env.account },
                access_token: 'synthetic-token-not-transmitted',
              }
            : null,
        },
        error: null,
      }
    },
    onAuthStateChange(callback) {
      authListeners.add(callback)
      return {
        data: {
          subscription: {
            unsubscribe() {
              authListeners.delete(callback)
            },
          },
        },
      }
    },
  }
  env.request = async (requestPath, init) => {
    assert.equal(requestPath, '/api/workspace?surface=owner-management-consent')
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      env.posts.push(body)
      if (!receipts.has(body.requestId)) {
        env.writes++
        env.grant = {
          id: GRANT,
          client_id: CLIENT,
          revision: env.writes,
          revoked_at:
            body.decision === 'revoke' ? '2026-10-02T00:00:00Z' : null,
          consent_version: 2,
        }
        receipts.set(body.requestId, {
          requestId: body.requestId,
          decision: body.decision,
          refreshRequired: true,
          receipt: {
            outcome: body.decision === 'approve' ? 'APPROVED' : 'REVOKED',
            grant_id: GRANT,
            grant_revision: env.writes,
          },
        })
      }
      if (env.unknownFirst && env.posts.length === 1) {
        return Response.json(
          { code: 'CONSENT_OUTCOME_UNCONFIRMED' },
          { status: 503 },
        )
      }
      return Response.json(receipts.get(body.requestId))
    }
    env.reads++
    return Response.json({
      account: { id: env.account, email: 'synthetic@example.invalid' },
      consent: {
        version: 2,
        capability: 'workspace.manage',
        title: 'Synthetic scope',
        scope: ['Independent preparation'],
        exclusions: ['No external effects'],
        duration: 'Until revoked',
      },
      consentTextHash: 'a'.repeat(64),
      clients: [
        {
          id: CLIENT,
          name: 'Synthetic client',
          canApprove: true,
          grant: env.grant,
        },
      ],
    })
  }
  return env
}

function makeController(env) {
  const slots = []
  const pendingEffects = []
  const cleanups = []
  const listeners = new Map()
  let index = 0
  let tree
  const same = (a, b) =>
    a && b && a.length === b.length && a.every((value, i) => value === b[i])
  const react = {
    useState(initial) {
      const i = index++
      if (!(i in slots))
        slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value
        },
      ]
    },
    useRef(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useMemo(factory, deps) {
      const i = index++
      if (!slots[i] || !same(slots[i].deps, deps))
        slots[i] = { value: factory(), deps }
      return slots[i].value
    },
    useEffect(effect, deps) {
      const i = index++
      if (!slots[i] || !same(slots[i].deps, deps)) {
        slots[i] = { deps }
        pendingEffects.push(effect)
      }
    },
  }
  const window = {
    location: { href: 'https://fixture.invalid/?manage_access=1', assign() {} },
    sessionStorage: env.storage,
    setTimeout,
    addEventListener(name, listener) {
      listeners.set(name, listener)
    },
    removeEventListener(name) {
      listeners.delete(name)
    },
  }
  function load(relative, overrides) {
    const source = fs.readFileSync(path.join(repo, relative), 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText
    const module = { exports: {} }
    vm.runInNewContext(
      output,
      {
        module,
        exports: module.exports,
        require(name) {
          if (Object.hasOwn(overrides, name)) return overrides[name]
          if (name.endsWith('.css')) return {}
          return repoRequire(name)
        },
        window,
        document: { title: '' },
        crypto: webcrypto,
        URL,
        Response,
        Error,
        console,
        fetch() {
          throw new Error('Network is forbidden in this harness')
        },
      },
      { filename: relative },
    )
    return module.exports
  }
  const client = load(files[1], {
    '../backendEndpoints.js': { fetchBackend: env.request },
  })
  const pending = load(files[2], {
    './ownerManagementConsentClient.js': client,
  })
  const jsx = (type, props) => ({ type, props })
  const Component = load(files[0], {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../BrandMark.js': {
      default() {
        return null
      },
    },
    './supabaseClient.js': { pjsdasSupabase: { auth: env.auth } },
    './ownerManagementConsentClient.js': client,
    './ownerConsentPending.js': pending,
  }).default
  function render() {
    index = 0
    tree = Component()
    while (pendingEffects.length) {
      const cleanup = pendingEffects.shift()()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  }
  const nodes = (node) =>
    Array.isArray(node)
      ? node.flatMap(nodes)
      : !node || typeof node !== 'object'
        ? []
        : [node, ...nodes(node.props?.children)]
  const text = (node) =>
    typeof node === 'string'
      ? node
      : Array.isArray(node)
        ? node.map(text).join('')
        : node?.props
          ? text(node.props.children)
          : ''
  const all = () => nodes(tree)
  const button = (label) =>
    all().find((node) => node.type === 'button' && text(node) === label)
  const checkbox = () => all().find((node) => node.type === 'input')
  const select = () => all().find((node) => node.type === 'select')
  const controller = {
    render,
    button,
    checkbox,
    select,
    async flush() {
      for (let i = 0; i < 5; i++) {
        await new Promise(setImmediate)
        render()
      }
    },
    async start() {
      render()
      await controller.flush()
    },
    selectAndConfirm() {
      select().props.onChange({ target: { value: CLIENT } })
      render()
      checkbox().props.onChange({ target: { checked: true } })
      render()
    },
    click(label) {
      const target = button(label)
      assert.ok(target, `Expected button: ${label}`)
      assert.equal(
        Boolean(target.props.disabled),
        false,
        `Button should be enabled: ${label}`,
      )
      target.props.onClick()
    },
    pageShow() {
      listeners.get('pageshow')({ persisted: true })
    },
    unmount() {
      for (const cleanup of cleanups) cleanup()
    },
    text() {
      return text(tree)
    },
  }
  return controller
}

const cases = []
async function check(name, callback) {
  try {
    await callback()
    cases.push({ name, passed: true })
    console.log('PASS', name)
  } catch (error) {
    cases.push({ name, passed: false })
    console.error('FAIL', name, error.message)
  }
}

async function main() {
  await check(
    'persisted pageshow freshly reads and invalidates old selection/confirmation',
    async () => {
      const env = makeEnvironment(),
        ui = makeController(env)
      await ui.start()
      ui.selectAndConfirm()
      const before = env.reads
      ui.pageShow()
      await ui.flush()
      assert.ok(env.reads > before)
      assert.equal(ui.checkbox().props.checked, false)
      assert.equal(ui.button('授权这个客户端').props.disabled, true)
      assert.equal(env.posts.length, 0)
      ui.unmount()
    },
  )
  await check(
    'unknown request survives pre-POST session loss and exact-body recovery after recreation',
    async () => {
      const env = makeEnvironment()
      env.unknownFirst = true
      const first = makeController(env)
      await first.start()
      first.selectAndConfirm()
      first.click('授权这个客户端')
      await first.flush()
      assert.ok(first.button('重试同一请求'))
      first.click('重新读取状态')
      await first.flush()
      env.account = null // Deliberately no auth callback before retry, to exercise its own check.
      first.click('重试同一请求')
      await first.flush()
      assert.equal(env.posts.length, 1)
      assert.equal(first.select(), undefined)
      assert.ok(first.button('使用 Google 登录 TodayAction'))
      assert.equal(env.persistedValues().length, 1)
      first.unmount()
      env.account = OWNER
      const second = makeController(env)
      await second.start()
      assert.equal(
        env.posts.length,
        1,
        'Restoration must not retry automatically',
      )
      assert.ok(second.button('重试同一请求'))
      second.click('重试同一请求')
      await second.flush()
      assert.equal(env.posts.length, 2)
      assert.deepEqual(env.posts[0], env.posts[1])
      assert.equal(env.writes, 1)
      assert.equal(env.persistedValues().length, 0)
      assert.equal(second.button('重试同一请求'), undefined)
      second.unmount()
    },
  )
  await check('storage write failure prevents POST', async () => {
    const env = makeEnvironment(),
      ui = makeController(env)
    await ui.start()
    ui.selectAndConfirm()
    env.failSave = true
    ui.click('授权这个客户端')
    await ui.flush()
    assert.equal(env.posts.length, 0)
    assert.match(ui.text(), /尚未发送/)
    ui.unmount()
  })
  await check(
    'pending request remains isolated across account changes',
    async () => {
      const env = makeEnvironment()
      env.unknownFirst = true
      const ui = makeController(env)
      await ui.start()
      ui.selectAndConfirm()
      ui.click('授权这个客户端')
      await ui.flush()
      await env.switchAccount(OTHER)
      await ui.flush()
      assert.equal(ui.button('重试同一请求'), undefined)
      await env.switchAccount(OWNER)
      await ui.flush()
      assert.ok(ui.button('重试同一请求'))
      assert.equal(env.posts.length, 1)
      ui.unmount()
    },
  )
  await check(
    'BFCache restoration reloads durable pending state created by another same-tab document',
    async () => {
      const env = makeEnvironment()
      env.unknownFirst = true
      const cached = makeController(env)
      await cached.start() // Caches owner -> null.
      const newer = makeController(env)
      await newer.start()
      newer.selectAndConfirm()
      newer.click('授权这个客户端')
      await newer.flush()
      assert.equal(env.posts.length, 1)
      assert.equal(env.persistedValues().length, 1)
      newer.unmount()
      cached.pageShow()
      await cached.flush()
      assert.ok(
        cached.button('重试同一请求'),
        'Restored old document must discover the newer persisted uncertain request',
      )
      assert.equal(cached.select().props.disabled, true)
      assert.equal(env.posts.length, 1)
      cached.unmount()
    },
  )
  const failed = cases.filter((result) => !result.passed).length
  console.log(
    `${cases.length - failed}/${cases.length} synthetic actual-source contracts passed.`,
  )
  console.log(
    'NOT_RUN: real React DOM, browser navigation/BFCache, browser security, accessibility, and visual layout.',
  )
  process.exitCode = failed ? 1 : 0
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
