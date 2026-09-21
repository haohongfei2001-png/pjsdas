# UU06 Gmail Push — candidate architecture and activation runbook

State: **CANDIDATE / NOT DEPLOYED**
Round: UU-06 only.
Owner authorization: 2026-09-21, bounded to Gmail API official push + Cloud Pub/Sub + minimum IAM + compensation sync no slower than 15 minutes.

This document does not certify live push, enable a mailbox, create a Google Cloud resource, expand Gmail scopes, or start UU-07.

## Frozen boundary

~~~text
Gmail notification
  -> authenticated Cloud Pub/Sub push
  -> /api/gmail-push
  -> bounded enqueue of the existing /api/automation-gmail worker
  -> existing history.list cursor
  -> existing message fetch / parser
  -> existing Semantic Intake
  -> existing lease / CAS / receipt / workspace write
~~~

The Pub/Sub notification is only a wake signal. It is not business evidence and does not directly create or mutate Opportunity, ScheduleNode, Process or Action state.

Gmail authorization remains exactly:

~~~text
https://www.googleapis.com/auth/gmail.readonly
~~~

No send, modify, label, archive, delete, application-submit, withdrawal or recruiting-email authority is added.

## Why the push payload is not trusted as business truth

Gmail Pub/Sub sends mailbox identity and a history cursor. The endpoint authenticates the Google-signed OIDC token, validates the bounded payload, resolves exactly one already-enabled explicit-consent binding, and asks the existing worker to resume from its durable history cursor.

Duplicate, delayed, coalesced or out-of-order notifications therefore converge through the existing history/cursor/idempotency path. The notified historyId is validated but never used to overwrite the authoritative ingestion cursor.

## Watch lifecycle

An explicit first-party UU06 Gmail enable registers users.watch only after:
- the authenticated PJSDAS user owns the stored Google binding;
- gmail.readonly is present;
- gmailIntakeConsentVersion=uu06-v1 is supplied;
- the existing encrypted refresh token can obtain an access token;
- the configured Pub/Sub topic is valid.

The watch intentionally has no INBOX label filter because the frozen UU06 contract requires recruitment mail outside INBOX not to be silently missed.

Operational watch metadata is separate from the ingestion cursor:
- gmail_watch_history_id
- gmail_watch_expires_at
- gmail_watch_last_renewed_at
- gmail_watch_last_error

Revocation, disable, account/credential replacement, scope removal, or loss of UU06 consent clears watch metadata.

A daily scheduler calls /api/automation-gmail-watch using the existing Gmail worker Vault credential. Only enabled, non-revoked, explicit-UU06-consent bindings are renewed.

## Push authentication

Production subscription target:

~~~text
https://todayaction.com/api/gmail-push
~~~

Pub/Sub must use authenticated push with a dedicated user-managed service account. PJSDAS validates:
- Google issuer;
- token signature/validity through Google's token verification endpoint;
- exact audience;
- exact service-account email;
- verified email claim.

Environment variables are server-only:

~~~text
PJSDAS_GMAIL_PUBSUB_TOPIC
PJSDAS_GMAIL_PUSH_AUDIENCE
PJSDAS_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL
~~~

The push endpoint uses the already-required server-only Supabase service-role credential only to call one narrow RPC. That RPC can enqueue the existing Gmail worker for exactly one eligible email binding. It cannot read mail, write workspace truth, change consent, or grant permissions.

## Minimum Google Cloud resources

Use the same existing Google Cloud project that owns the PJSDAS Gmail OAuth client.

Recommended names:

~~~text
topic:        pjsdas-gmail-events
subscription: pjsdas-gmail-events-production
push SA:      pjsdas-gmail-push@PROJECT_ID.iam.gserviceaccount.com
~~~

Required minimum IAM:
1. grant gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on the single topic;
2. allow the Pub/Sub service agent for the project to mint OIDC tokens for the dedicated push service account;
3. the setup principal may need iam.serviceAccounts.actAs to bind that service account while creating the subscription; do not grant this to PJSDAS runtime.

No broad project Editor/Owner grant is required by the application.

Illustrative setup only — do not run until project identity and billing boundary are verified:

~~~bash
PROJECT_ID="..."
PROJECT_NUMBER="..."
TOPIC="pjsdas-gmail-events"
SUBSCRIPTION="pjsdas-gmail-events-production"
PUSH_SA="pjsdas-gmail-push@${PROJECT_ID}.iam.gserviceaccount.com"
PUSH_ENDPOINT="https://todayaction.com/api/gmail-push"

gcloud services enable gmail.googleapis.com pubsub.googleapis.com --project "$PROJECT_ID"

gcloud pubsub topics create "$TOPIC" --project "$PROJECT_ID"

gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --project "$PROJECT_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud iam service-accounts create pjsdas-gmail-push \
  --project "$PROJECT_ID" \
  --display-name="PJSDAS Gmail PubSub push"

gcloud iam service-accounts add-iam-policy-binding "$PUSH_SA" \
  --project "$PROJECT_ID" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"

gcloud pubsub subscriptions create "$SUBSCRIPTION" \
  --project "$PROJECT_ID" \
  --topic="$TOPIC" \
  --push-endpoint="$PUSH_ENDPOINT" \
  --push-auth-service-account="$PUSH_SA" \
  --push-auth-token-audience="$PUSH_ENDPOINT"
~~~

Before applying this setup, inspect the existing project's billing/account state. If it requires a new paid plan, billing-account commitment or other paid resource beyond already-authorized usage, stop for owner confirmation.

## Compensation path

The historical hourly Gmail scheduler is converted in-place to:

~~~text
*/10 * * * *
~~~

Its command, endpoint, Vault identity and idle eligibility predicate are preserved. Ten minutes is deliberately below the frozen <=15 minute missed-push recovery ceiling. Discovery is untouched.

Push is the normal low-latency wake path. Compensation remains the correctness/recovery path.

## Deployment order

1. Candidate CI / build / browser / review passes.
2. Apply only the additive watch-state schema migration.
3. Deploy backend endpoints and server environment configuration.
4. Verify endpoints fail closed before any mailbox is enabled.
5. Apply the compensation/watch-renewal scheduler migration.
6. Create/verify the bounded Google Cloud topic, IAM and authenticated push subscription.
7. Explicitly enable the owner's Gmail binding with UU06 consent; this registers the watch.
8. Run a bounded real canary with synthetic recruiting emails.
9. Measure source-to-commit latency and compensation recovery using existing bounded metrics.
10. Only after the UU06 acceptance evidence passes may canonical status become COMPLETE. Do not start UU-07.

## Required live canary evidence

At minimum:
- watch registration succeeds and stores only operational metadata;
- initial watch notification and a later real message both reach the authenticated push endpoint;
- normal push-driven source-to-commit latency supports the frozen p95 <2 minute claim;
- a deliberately suppressed/ignored push is recovered by compensation within 15 minutes;
- duplicate push causes no duplicate business fact;
- archived/non-INBOX recruiting mail is consumed under explicit UU06 consent;
- reschedule/cancel/completion still use existing stable occurrence and Semantic Intake semantics;
- disable/revoke stops both watch renewal and push enqueue;
- no raw email body, token, push JWT or personal message content appears in public evidence.
