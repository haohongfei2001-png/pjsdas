import { readFile, writeFile } from 'node:fs/promises'

async function patch(path, changes) {
  let text = await readFile(path, 'utf8')
  for (const [before, after, label] of changes) {
    if (!text.includes(before)) throw new Error(`${path}: missing anchor ${label}`)
    text = text.replace(before, after)
  }
  await writeFile(path, text)
}

await patch('src/AppV5.tsx', [
  [
    "import CloudSettingsCard from './cloud/CloudSettingsCard.js'\n",
    "import CloudSettingsCard from './cloud/CloudSettingsCard.js'\nimport DiscoveryProfileCard from './DiscoveryProfileCard.js'\n",
    'DiscoveryProfileCard import',
  ],
  [
    "      <CloudSettingsCard />\n\n      <div className=\"import-card\">",
    "      <CloudSettingsCard />\n      <DiscoveryProfileCard />\n\n      <div className=\"import-card\">",
    'DiscoveryProfileCard render',
  ],
])

await patch('src/ai/readLayer.ts', [
  [
    "import { decisionRulesForSnapshot, type DecisionRules, type DecisionWeights } from '../decisionRules.js'\n",
    "import { decisionRulesForSnapshot, type DecisionRules, type DecisionWeights } from '../decisionRules.js'\nimport { discoveryProfileForSnapshot, type DiscoveryProfile } from '../discoveryProfile.js'\n",
    'discovery profile import',
  ],
  [
    "export interface ExplainPriorityInput {",
    "export interface GetDiscoveryContextOutput {\n  meta: BridgeMeta\n  configured: boolean\n  profile: DiscoveryProfile\n  decisionWeights: DecisionWeights\n  existingOpportunities: Array<{\n    opportunityId: string\n    company: string\n    role: string\n    stage: string\n    roleType: Opportunity['roleType']\n    deadline?: string\n  }>\n  recentlyClosed: Array<{\n    opportunityId: string\n    company: string\n    role: string\n  }>\n  instructions: string[]\n}\n\nexport interface ExplainPriorityInput {",
    'discovery context output',
  ],
  [
    "const componentLabels: Record<keyof DecisionWeights, string> = {",
    "function discoveryProfileConfigured(profile: DiscoveryProfile) {\n  return Boolean(\n    profile.targetRoleQueries.length ||\n    profile.preferredLocations.length ||\n    profile.locationNotes ||\n    profile.minimumAnnualCompensationWan !== undefined ||\n    profile.mustHave.length ||\n    profile.mustNotHave.length ||\n    profile.strengths.length ||\n    profile.notes\n  )\n}\n\nexport function getDiscoveryContext(\n  snapshot: PJSDASSnapshot,\n  bridgeContext: BridgeReadContext = {},\n): GetDiscoveryContextOutput {\n  const context = resolvedContext(bridgeContext)\n  const workspace = readWorkspace(snapshot)\n  const profile = discoveryProfileForSnapshot(snapshot.data.discoveryProfile)\n  const active = workspace.opportunities\n    .filter((item) => item.processStage !== 'closed')\n    .sort((a, b) => a.company.localeCompare(b.company) || a.role.localeCompare(b.role))\n    .slice(0, 150)\n  const recentlyClosed = workspace.opportunities\n    .filter((item) => item.processStage === 'closed')\n    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))\n    .slice(0, 60)\n\n  return {\n    meta: meta(context),\n    configured: discoveryProfileConfigured(profile),\n    profile,\n    decisionWeights: { ...workspace.rules.weights },\n    existingOpportunities: active.map((item) => ({\n      opportunityId: item.id,\n      company: item.company,\n      role: item.role,\n      stage: item.processStage,\n      roleType: item.roleType,\n      deadline: item.deadline,\n    })),\n    recentlyClosed: recentlyClosed.map((item) => ({\n      opportunityId: item.id,\n      company: item.company,\n      role: item.role,\n    })),\n    instructions: [\n      'Use the explicit Discovery Profile as durable search preferences; do not silently infer or rewrite it.',\n      'Search public job sources outside PJSDAS, and keep unknown salary, deadline or location fields unknown instead of inventing them.',\n      'Do not rediscover an obviously identical company+role already present in existingOpportunities.',\n      'Use propose_changes for any candidate the user wants to add; never claim discovery results were added before ChangeSet review and Apply.',\n    ],\n  }\n}\n\nconst componentLabels: Record<keyof DecisionWeights, string> = {",
    'getDiscoveryContext function',
  ],
])

await patch('gateway/readTools.ts', [
  [
    "  getDecisionRules,\n  getPipeline,",
    "  getDecisionRules,\n  getDiscoveryContext,\n  getPipeline,",
    'readLayer discovery import',
  ],
  [
    "  'get_decision_rules',\n  'explain_priority',",
    "  'get_decision_rules',\n  'get_discovery_context',\n  'explain_priority',",
    'read tool name',
  ],
  [
    "export const getDecisionRulesSchema = z.object({})\n\nexport const explainPrioritySchema",
    "export const getDecisionRulesSchema = z.object({})\nexport const getDiscoveryContextSchema = z.object({})\n\nexport const explainPrioritySchema",
    'discovery schema',
  ],
  [
    "      case 'get_decision_rules':\n        getDecisionRulesSchema.parse(args)\n        return success(getDecisionRules(snapshot, context))\n      case 'explain_priority':",
    "      case 'get_decision_rules':\n        getDecisionRulesSchema.parse(args)\n        return success(getDecisionRules(snapshot, context))\n      case 'get_discovery_context':\n        getDiscoveryContextSchema.parse(args)\n        return success(getDiscoveryContext(snapshot, context))\n      case 'explain_priority':",
    'discovery invocation',
  ],
])

await patch('gateway/serverFactory.ts', [
  [
    "  getPipelineSchema,\n  getRecentTimelineSchema,",
    "  getPipelineSchema,\n  getRecentTimelineSchema,\n  getDiscoveryContextSchema,",
    'discovery schema import',
  ],
  [
    "  server.registerTool(\n    'explain_priority',",
    "  server.registerTool(\n    'get_discovery_context',\n    {\n      title: 'Get PJSDAS job discovery context',\n      description: 'Read the user-controlled Discovery Profile, active decision weights, and bounded existing opportunity identities before searching the web for new jobs. This tool does not search the web or mutate PJSDAS.',\n      inputSchema: getDiscoveryContextSchema,\n      annotations: readOnlyAnnotations,\n    },\n    async (args) => invokeReadTool(source, 'get_discovery_context', args),\n  )\n\n  server.registerTool(\n    'explain_priority',",
    'register discovery tool',
  ],
])

await patch('tests/mcpGateway.test.ts', [
  [
    "      'get_decision_rules',\n      'explain_priority',",
    "      'get_decision_rules',\n      'get_discovery_context',\n      'explain_priority',",
    'expected read names',
  ],
  [
    "    ['get_decision_rules', {}],\n    ['explain_priority',",
    "    ['get_decision_rules', {}],\n    ['get_discovery_context', {}],\n    ['explain_priority',",
    'discovery tool invocation test',
  ],
])
