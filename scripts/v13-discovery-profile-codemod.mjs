import { readFile, writeFile } from 'node:fs/promises'

const path = 'src/db.ts'
let text = await readFile(path, 'utf8')

function replaceOnce(before, after, label) {
  if (!text.includes(before)) throw new Error(`Missing codemod anchor: ${label}`)
  text = text.replace(before, after)
}

replaceOnce(
  "import { createDefaultDecisionRules, decisionRulesForSnapshot, validateDecisionRules, type DecisionRules } from './decisionRules.js'\n",
  "import { createDefaultDecisionRules, decisionRulesForSnapshot, validateDecisionRules, type DecisionRules } from './decisionRules.js'\nimport {\n  createDefaultDiscoveryProfile,\n  normalizeDiscoveryProfile,\n  validateDiscoveryProfile,\n  type DiscoveryProfile,\n} from './discoveryProfile.js'\n",
  'discovery profile import',
)

replaceOnce(
  "  decisionRules: { key: string; value: DecisionRules }\n  timeline: {",
  "  decisionRules: { key: string; value: DecisionRules }\n  discoveryProfiles: { key: string; value: DiscoveryProfile }\n  timeline: {",
  'database schema',
)

replaceOnce(
  "  'decisionRules',\n  'timeline',",
  "  'decisionRules',\n  'discoveryProfiles',\n  'timeline',",
  'data stores',
)

replaceOnce(
  "export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 6, {",
  "export const dbPromise = openDB<PJSDASDatabase>('pjsdas', 7, {",
  'database version',
)

replaceOnce(
  "    if (!db.objectStoreNames.contains('decisionRules')) {\n      db.createObjectStore('decisionRules', { keyPath: 'key' })\n    }\n    if (!db.objectStoreNames.contains('timeline')) {",
  "    if (!db.objectStoreNames.contains('decisionRules')) {\n      db.createObjectStore('decisionRules', { keyPath: 'key' })\n    }\n    if (!db.objectStoreNames.contains('discoveryProfiles')) {\n      db.createObjectStore('discoveryProfiles', { keyPath: 'key' })\n    }\n    if (!db.objectStoreNames.contains('timeline')) {",
  'discovery profile store',
)

replaceOnce(
  "export async function getDecisionRules() {\n  const stored = await (await dbPromise).get('decisionRules', 'current')\n  return stored ?? decisionRulesForSnapshot()\n}\n\nasync function ensureTimelineBackfill",
  "export async function getDecisionRules() {\n  const stored = await (await dbPromise).get('decisionRules', 'current')\n  return stored ?? decisionRulesForSnapshot()\n}\n\nexport async function getDiscoveryProfile() {\n  const stored = await (await dbPromise).get('discoveryProfiles', 'current')\n  return stored ?? createDefaultDiscoveryProfile('1970-01-01T00:00:00.000Z')\n}\n\nexport async function saveDiscoveryProfile(profile: DiscoveryProfile) {\n  const next = normalizeDiscoveryProfile(profile)\n  const errors = validateDiscoveryProfile(next)\n  if (errors.length) throw new Error(errors[0])\n  await (await dbPromise).put('discoveryProfiles', next)\n  return next\n}\n\nasync function ensureTimelineBackfill",
  'profile accessors',
)

replaceOnce(
  "  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, timeline, changeSets, meta] =\n    await Promise.all([",
  "  const [opportunities, processes, processEvents, actions, prep, applicationGroups, decisionRules, discoveryProfile, timeline, changeSets, meta] =\n    await Promise.all([",
  'snapshot destructure',
)

replaceOnce(
  "      db.get('decisionRules', 'current'),\n      db.getAll('timeline'),",
  "      db.get('decisionRules', 'current'),\n      db.get('discoveryProfiles', 'current'),\n      db.getAll('timeline'),",
  'snapshot profile read',
)

replaceOnce(
  "    decisionRules: decisionRulesForSnapshot(decisionRules),\n    timeline,",
  "    decisionRules: decisionRulesForSnapshot(decisionRules),\n    discoveryProfile,\n    timeline,",
  'snapshot profile field',
)

const restoreAnchor = "  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())\n  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)"
const restoreReplacement = "  await tx.objectStore('decisionRules').put(snapshot.data.decisionRules ?? createDefaultDecisionRules())\n  if (snapshot.data.discoveryProfile) await tx.objectStore('discoveryProfiles').put(snapshot.data.discoveryProfile)\n  for (const item of snapshot.data.timeline ?? []) await tx.objectStore('timeline').put(item)"
if (text.split(restoreAnchor).length - 1 !== 2) throw new Error('Expected two snapshot restore anchors')
text = text.split(restoreAnchor).join(restoreReplacement)

await writeFile(path, text)
