import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = process.cwd()
const manifest = JSON.parse(readFileSync(resolve(root, 'public/brand/ASSET_MANIFEST.json'), 'utf8'))
if (manifest.schema !== 'todayaction-brand-assets-v1') throw new Error('Unsupported brand asset manifest.')
for (const [path, expected] of Object.entries(manifest.assets)) {
  if (!/^public\/(?:brand\/)?[\w.-]+$/.test(path)) throw new Error('Invalid brand asset path.')
  const bytes = readFileSync(resolve(root, path))
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('Brand asset checksum failed: ' + path)
  }
  if (path.endsWith('.png') && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG: ' + path)
}
console.log('TodayAction brand asset checksums verified.')
