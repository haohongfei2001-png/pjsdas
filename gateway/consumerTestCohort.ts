/** Server-only controlled admission. Configuration never issues a grant. */
export interface ConsumerTestCohort { accountIds?: string; clientId?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function configuredConsumerTestCohort(): ConsumerTestCohort {
  return { accountIds: process.env.PJSDAS_CONSUMER_TEST_ACCOUNT_IDS, clientId: process.env.PJSDAS_CONSUMER_TEST_CLIENT_ID }
}
export function consumerTestAccountAllowed(userId: string, cohort?: ConsumerTestCohort) {
  const accounts = cohort?.accountIds?.split(',').map(value => value.trim()) ?? []
  return accounts.length === 2 && new Set(accounts).size === 2 && accounts.every(value => uuid.test(value))
    && uuid.test(cohort?.clientId ?? '') && accounts.includes(userId)
}
export function consumerTestClientAllowed(userId: string, clientId: string | undefined, cohort?: ConsumerTestCohort) {
  return consumerTestAccountAllowed(userId, cohort) && clientId === cohort?.clientId
}
