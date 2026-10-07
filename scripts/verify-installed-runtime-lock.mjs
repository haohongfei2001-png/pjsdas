import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Browser tooling must exercise the runtime dependencies installed by npm ci.
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
