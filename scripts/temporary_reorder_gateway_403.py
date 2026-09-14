from pathlib import Path

path = Path('gateway/discoveryAutomationWorker.ts')
text = path.read_text()
start = text.index("  if (status === 403) {")
end = text.index("  if (status === 429", start)
replacement = """  if (status === 403) {
    if (details.type === 'customer_verification_required') {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_CUSTOMER_VERIFICATION_REQUIRED', 'Vercel AI Gateway requires team payment-method verification before background discovery can use Gateway credits.', false)
    }
    if (message.includes('free tier')) {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_CREDITS_REQUIRED', 'The selected discovery model is not available on the current Vercel AI Gateway free tier.', false)
    }
    if (details.type === 'no_providers_available' || message.includes('allowlist') || message.includes('not allowed') || message.includes('restriction') || message.includes('restricted access')) {
      throw new WorkspaceSourceError('DISCOVERY_MODEL_RESTRICTED', 'Vercel AI Gateway team restrictions block the selected discovery model or provider.', false)
    }
    if (details.type === 'forbidden') {
      const ruleSuffix = details.ruleId ? ` (routing rule ${details.ruleId})` : ''
      throw new WorkspaceSourceError(
        'DISCOVERY_MODEL_POLICY_FORBIDDEN',
        `Vercel AI Gateway routing policy denied the discovery-model request${ruleSuffix}.`,
        false,
      )
    }
    throw new WorkspaceSourceError('DISCOVERY_MODEL_FORBIDDEN', "Vercel AI Gateway denied this project's discovery-model request.", false)
  }
"""
path.write_text(text[:start] + replacement + text[end:])
