# PJSDAS Background Gmail Automation

## Product contract

PJSDAS may track recruiting email in the background after one explicit Google authorization for the Gmail read-only scope.

The intended user flow is:

1. Sign in to PJSDAS with Google as usual.
2. In Settings, choose **Authorize Gmail and enable** once.
3. Google grants `https://www.googleapis.com/auth/gmail.readonly` in addition to the existing Drive appDataFolder scope.
4. PJSDAS stores the Google refresh token encrypted with the existing AES-GCM token-encryption key.
5. The background worker runs without requiring the PJSDAS site or ChatGPT to remain open.

Disabling the feature stops background Gmail ingestion without deleting the PJSDAS workspace or the Google Drive connection.

## Privacy and mutation boundary

- Gmail access is read-only. PJSDAS does not send, edit, label, archive, or delete mail.
- Raw email bodies are decoded only in worker memory and are not persisted in PJSDAS.
- Durable Gmail source identity uses the Gmail message ID.
- Bounded metadata and recruiting facts may include sender, subject, company, role, process-event type, timing, and stage.
- High-confidence source-backed facts reuse the existing Gmail trusted-ingestion pipeline.
- Ambiguous identity, event type, or required timing fails closed to `unresolved` rather than being guessed.
- Decision Rules, durable preferences, deletions, and user decisions such as abandoning an opportunity remain outside autonomous ingestion.

## Storage and reconciliation

The worker reuses the existing:

- ingestion ledger and accounting invariant;
- Gmail message idempotency;
- logical Opportunity / Process Event reconciliation;
- deterministic Process Action generation;
- Google Drive appDataFolder workspace;
- optimistic `workspaceVersion` conflict guard.

The Gmail cursor is advanced only after the corresponding workspace ingestion succeeds. A failed write therefore cannot silently acknowledge source records that were not committed.

## Background authorization

The scheduler token is generated inside Supabase Vault under:

`pjsdas_gmail_automation_worker_token`

The secret value is never stored in GitHub or required as a Vercel environment variable.

The public Vercel worker accepts the token as a Bearer credential and forwards it to two narrow SECURITY DEFINER RPCs:

- `pjsdas_claim_gmail_automation_bindings`
- `pjsdas_update_gmail_automation_state`

Those RPCs validate the token against Vault before returning an enabled encrypted binding or updating worker telemetry/cursor state.

## Deployment order

The database migration is safe to apply before the application deployment because it is additive and does not activate the scheduler.

The production order is deliberately fail-closed:

1. Apply `supabase/migrations/2026091501_gmail_automation_worker.sql`.
2. Keep `pjsdas-gmail-automation-hourly` unscheduled.
3. Merge/deploy the matching backend and frontend commit.
4. Require CI and Browser E2E success.
5. Require the normal exact-backend Pages gate and Production Self-Test.
6. Production Self-Test must confirm `/api/automation-settings` and `/api/automation-gmail` exist and reject unauthenticated requests.
7. Only then enable the scheduler.

The currently intended cadence is once per hour at minute 7:

```sql
select cron.schedule(
  'pjsdas-gmail-automation-hourly',
  '7 * * * *',
  $cron$
  select net.http_post(
    url := 'https://pjsdas-remote-alpha.vercel.app/api/automation-gmail',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'pjsdas_gmail_automation_worker_token'
        limit 1
      )
    ),
    timeout_milliseconds := 50000
  );
  $cron$
);
```

Never enable this cron before the matching worker endpoint is live and production-verified.

## Operational signals

Per-user automation state is stored in `google_drive_connections`:

- `gmail_automation_enabled`
- `gmail_history_id`
- `gmail_last_checked_at`
- `gmail_last_success_at`
- `gmail_last_error`

The error field is bounded operational telemetry and must never contain raw email bodies.

## External prerequisite

The Google Cloud project used by PJSDAS must have the Gmail API enabled. Public distribution of Gmail read-only access is also subject to Google's restricted-scope verification requirements. This infrastructure does not weaken or bypass those provider requirements.
