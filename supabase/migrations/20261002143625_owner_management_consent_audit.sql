-- Source-only. No grant is issued and no live feature is activated by this migration.
create table public.pjsdas_management_consent_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  client_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('approve', 'revoke')),
  consent_version integer not null check (consent_version = 2),
  consent_text_hash text not null check (consent_text_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid,
  grant_revision bigint,
  outcome text not null check (outcome in ('APPROVED', 'REVOKED', 'ALREADY_REVOKED')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, request_id)
);
alter table public.pjsdas_management_consent_events enable row level security;
revoke all on table public.pjsdas_management_consent_events from public, anon, authenticated, service_role;
grant select, insert on table public.pjsdas_management_consent_events to service_role;

create function public.pjsdas_decide_management_consent_v1(
 target_user_id uuid, target_client_id uuid, target_request_id uuid,
 target_request_hash text, target_decision text, target_consent_version integer,
 target_consent_text_hash text, target_expected_grant_id uuid,
 target_expected_grant_revision bigint, target_first_party boolean,
 target_provider_client_verified boolean
) returns table(outcome text, grant_id uuid, grant_revision bigint)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
 current_grant public.pjsdas_business_management_grants%rowtype;
 previous_event public.pjsdas_management_consent_events%rowtype;
 result_outcome text;
begin
 if target_first_party is distinct from true or target_user_id is null or target_client_id is null or target_request_id is null
   or target_decision is null or target_decision not in ('approve','revoke')
   or target_consent_version is distinct from 2
   or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$'
   or target_consent_text_hash is null or target_consent_text_hash !~ '^[0-9a-f]{64}$'
   or ((target_expected_grant_id is null) <> (target_expected_grant_revision is null))
   or target_expected_grant_revision < 1
   or (target_decision = 'approve' and target_provider_client_verified is distinct from true) then
  raise exception 'Explicit first-party consent with valid binding is required.' using errcode='42501';
 end if;
 -- Owner access cannot be revoked between this check and the consent transaction.
 perform 1 from public.pjsdas_access_grants a
   where a.user_id=target_user_id and a.role='owner' and a.revoked_at is null for share;
 if not found then raise exception 'Active owner access is required.' using errcode='42501'; end if;
 -- Serialize consent decisions for one account, including initially absent grants
 -- and concurrent reuse of the same request ID on different clients. No workspace lock.
 perform pg_advisory_xact_lock(hashtextextended('ta-management-consent:' || target_user_id::text, 0));
 select e.* into previous_event from public.pjsdas_management_consent_events e
   where e.user_id=target_user_id and e.request_id=target_request_id;
 if found then
  if previous_event.request_hash <> target_request_hash then raise exception 'Consent request ID reused.' using errcode='23505'; end if;
  return query select previous_event.outcome, previous_event.grant_id, previous_event.grant_revision;
  return;
 end if;
 select g.* into current_grant from public.pjsdas_business_management_grants g
   where g.user_id=target_user_id and g.client_id=target_client_id and g.capability='workspace.manage' for update;
 if found then
  if current_grant.id is distinct from target_expected_grant_id or current_grant.revision is distinct from target_expected_grant_revision then
   raise exception 'Consent view is stale; reload before a new explicit decision.' using errcode='40001';
  end if;
 elsif target_expected_grant_id is not null then
  raise exception 'Consent grant was replaced or removed.' using errcode='40001';
 end if;
 if target_decision='approve' then
  if current_grant.id is null then
   insert into public.pjsdas_business_management_grants(user_id,client_id,capability,consent_version,consent_text_hash)
    values(target_user_id,target_client_id,'workspace.manage',2,target_consent_text_hash) returning * into current_grant;
  else
   update public.pjsdas_business_management_grants g set revoked_at=null,granted_at=clock_timestamp(),consent_version=2,consent_text_hash=target_consent_text_hash
    where g.id=current_grant.id returning g.* into current_grant;
  end if;
  result_outcome:='APPROVED';
 elsif current_grant.id is null or current_grant.revoked_at is not null then
  result_outcome:='ALREADY_REVOKED';
 else
  update public.pjsdas_business_management_grants g set revoked_at=clock_timestamp() where g.id=current_grant.id returning g.* into current_grant;
  result_outcome:='REVOKED';
 end if;
 insert into public.pjsdas_management_consent_events(user_id,request_id,client_id,request_hash,decision,consent_version,consent_text_hash,grant_id,grant_revision,outcome)
  values(target_user_id,target_request_id,target_client_id,target_request_hash,target_decision,2,target_consent_text_hash,current_grant.id,current_grant.revision,result_outcome);
 return query select result_outcome,current_grant.id,current_grant.revision;
end $$;
revoke all on function public.pjsdas_decide_management_consent_v1(uuid,uuid,uuid,text,text,integer,text,uuid,bigint,boolean,boolean) from public,anon,authenticated;
grant execute on function public.pjsdas_decide_management_consent_v1(uuid,uuid,uuid,text,text,integer,text,uuid,bigint,boolean,boolean) to service_role;
