import { configuredConsumerTestCohort } from '../gateway/consumerTestCohort.js'
import { createScopedManagementConsentHandler } from '../gateway/scopedManagementConsentHandler.js'
import { createOwnerManagementConsentHandler } from '../gateway/ownerManagementConsentHandler.js'
import { createConnectedWorkspaceHandler } from '../gateway/connectedWorkspaceHandler.js'
import {
  PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  PJSDAS_SUPABASE_URL,
} from '../gateway/supabaseProject.js'
import { firstPartyWebOrigins, audienceMode } from '../gateway/productionTopology.js'
import { createConfiguredAudienceAccessGuard } from '../gateway/audienceAccess.js'

const handler = createConnectedWorkspaceHandler({
  consumerCohort: configuredConsumerTestCohort(),
  consumerOnboardingEnabled: process.env.PJSDAS_CONSUMER_ONBOARDING === 'enabled',
  consumerAudienceMode: audienceMode(),
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  allowedOrigins: firstPartyWebOrigins(),
  authorizeIdentity: createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL }),
})

// Reuse the existing function allocation; no new paid deployment resource.
const ownerConsentHandler = createOwnerManagementConsentHandler({
  enabled: process.env.PJSDAS_OWNER_MANAGEMENT_CONSENT,
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  allowedOrigins: firstPartyWebOrigins(),
  authorizeIdentity: createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL }),
})

const scopedConsentHandler = createScopedManagementConsentHandler({
  consumerCohort: configuredConsumerTestCohort(),
  consumerOnboardingEnabled: process.env.PJSDAS_CONSUMER_ONBOARDING === 'enabled',
  enabled: process.env.PJSDAS_OWNER_SCOPED_MANAGEMENT_CONSENT,
  consumerEnabled: process.env.PJSDAS_CONSUMER_SCOPED_MANAGEMENT,
  audienceMode: audienceMode(),
  supabaseUrl: PJSDAS_SUPABASE_URL,
  supabasePublishableKey: PJSDAS_SUPABASE_PUBLISHABLE_KEY,
  serviceRoleKey: process.env.PJSDAS_SUPABASE_SERVICE_ROLE_KEY ?? '',
  allowedOrigins: firstPartyWebOrigins(),
  authorizeIdentity: createConfiguredAudienceAccessGuard({ supabaseUrl: PJSDAS_SUPABASE_URL }),
})

export default {
  fetch(request: Request) {
    if (new URL(request.url).searchParams.get('surface') === 'scoped-management-consent') return scopedConsentHandler(request)
    if (new URL(request.url).searchParams.get('surface') === 'owner-management-consent') return ownerConsentHandler(request)
    return handler(request)
  },
}
