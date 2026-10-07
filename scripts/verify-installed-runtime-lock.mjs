import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Browser tooling must exercise the runtime dependencies installed by npm ci.
// Some container checkouts are archives without .git; compare actual bytes.
const digest = value => createHash('sha256').update(value).digest('hex')
const checkpoint = resolve(process.env.RUNNER_TEMP || tmpdir(), `todayaction-browser-inputs-${digest(process.cwd())}.json`)
const inputs = Object.fromEntries(['package.json', 'package-lock.json'].map(path => [path, digest(readFileSync(path))]))
if (process.argv.includes('--capture')) {
  writeFileSync(checkpoint, JSON.stringify(inputs))
  console.log('Captured project manifest and lock hashes before browser tool installation.')
  process.exit(0)
}
const before = JSON.parse(readFileSync(checkpoint, 'utf8'))
for (const [path, hash] of Object.entries(inputs)) {
  if (before[path] !== hash) throw new Error(`${path} changed during browser tool installation`)
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const checked = []
for (const [path, expected] of Object.entries(lock.packages)) {
  if (!path || expected.dev) continue
  let installed
  try { installed = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8')) }
  catch (error) {
    if (expected.optional && error.code === 'ENOENT') continue
    throw error
  }
  if (installed.version !== expected.version) {
    throw new Error(`${path}: expected locked ${expected.version}, installed ${installed.version}`)
  }
  checked.push(`${installed.name}@${installed.version}`)
}
console.log(`Verified ${checked.length} installed runtime packages against the unchanged project lock: ${checked.join(', ')}`)
