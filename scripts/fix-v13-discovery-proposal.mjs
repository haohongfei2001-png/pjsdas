import { readFile, writeFile } from 'node:fs/promises'

const path = 'gateway/proposeChanges.ts'
let text = await readFile(path, 'utf8')
const before = "const discovered = discoveredOperations(input.discoveredOpportunities, { snapshot, context } as Awaited<ReturnType<WorkspaceSource['read']>>, profile, now)"
const after = "const discovered = discoveredOperations(input.discoveredOpportunities, snapshot, profile, now)"
if (!text.includes(before)) throw new Error('proposal fix anchor not found')
text = text.replace(before, after)
await writeFile(path, text)
