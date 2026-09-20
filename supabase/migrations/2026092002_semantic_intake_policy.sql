-- PJSDAS Ultimate Usability v1 / UU-02
-- Extend delegated source grants for the shared Semantic Intake contract.
-- This migration grants no client/source by itself; it only adds the capability
-- to the allowlisted vocabulary. Actual grants remain explicit and user-scoped.

alter table public.pjsdas_authorization_grants
  drop constraint if exists pjsdas_authorization_grants_capability_check;

alter table public.pjsdas_authorization_grants
  add constraint pjsdas_authorization_grants_capability_check
  check (capability in ('ingest_discovery_run', 'ingest_gmail_run', 'semantic_intake'));

comment on column public.pjsdas_authorization_grants.capability is
  'Explicit delegated capability. semantic_intake authorizes only the shared bounded Semantic Intake kernel; it does not authorize external recruiting actions.';
