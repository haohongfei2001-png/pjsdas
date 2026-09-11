from pathlib import Path
p = Path('scripts/v14_round1_codemod.py')
s = p.read_text(encoding='utf-8')
start = s.index("replace_once(\n    'src/discoveryQuality.ts',\n    \"  for (const candidate of candidates) {\\n    const priorRejection")
end = s.index("replace_once(\n    'gateway/proposeChanges.ts'", start)
block = '''replace_once(
    'src/discoveryQuality.ts',
    "  for (const candidate of candidates) {\\n    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)",
    "  for (const candidate of candidates) {\\n"
    "    const inboxMatch = inbox.find((item) =>\\n"
    "      normalizedCompany(item.company) === normalizedCompany(candidate.company) &&\\n"
    "      discoveryRoleSimilarity(item.role, candidate.role) >= 0.72\\n"
    "    )\\n"
    "    if (inboxMatch && inboxMatch.status !== 'promoted') {\\n"
    "      const ageMs = now.getTime() - new Date(inboxMatch.updatedAt).getTime()\\n"
    "      if (inboxMatch.status === 'dismissed') {\\n"
    "        if (ageMs <= 120 * 24 * 60 * 60 * 1000) {\\n"
    "          rejectedCandidates.push({\\n"
    "            company: candidate.company,\\n"
    "            role: candidate.role,\\n"
    "            reasons: [`发现箱中高度相似岗位“${inboxMatch.company}｜${inboxMatch.role}”最近已被明确拒绝。`],\\n"
    "          })\\n"
    "          continue\\n"
    "        }\\n"
    "      } else {\\n"
    "        skippedDuplicates.push({\\n"
    "          company: candidate.company,\\n"
    "          role: candidate.role,\\n"
    "          reason: `高度相似岗位“${inboxMatch.company}｜${inboxMatch.role}”已经在发现箱（${inboxMatch.status}）。`,\\n"
    "        })\\n"
    "        continue\\n"
    "      }\\n"
    "    }\\n\\n"
    "    const latestFeedback = latestExplicitFeedbackForCandidate(timeline, candidate, now)",
)
'''
s = s[:start] + block + s[end:]
p.write_text(s, encoding='utf-8')
print('codemod quality-gate target fixed')
