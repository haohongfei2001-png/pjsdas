import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'

const dist = path.resolve(process.cwd(), 'dist')
const source = path.join(dist, 'index.html')
const target = path.join(dist, '404.html')

await stat(source)
await copyFile(source, target)
console.log('PJSDAS semantic-route fallback: dist/404.html')
