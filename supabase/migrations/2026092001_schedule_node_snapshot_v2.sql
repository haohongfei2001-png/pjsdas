-- PJSDAS Ultimate Usability v1 / UU-01
-- Snapshot schema v2 introduces ScheduleNode as the canonical recruiting-time model.
-- This guard is deliberately additive: existing v1 rows remain readable and are
-- upgraded by compatible readers, but once a workspace commits v2 an older
-- client may not overwrite it with a lower-schema whole snapshot.

create or replace function public.pjsdas_prevent_workspace_schema_downgrade()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.schema_version < old.schema_version then
    raise exception 'PJSDAS workspace schema downgrade is not allowed (% -> %).',
      old.schema_version, new.schema_version
      using errcode = '22023';
  end if;
  return new;
end
$$;

drop trigger if exists pjsdas_workspace_schema_no_downgrade on public.pjsdas_workspaces;
create trigger pjsdas_workspace_schema_no_downgrade
before update of schema_version on public.pjsdas_workspaces
for each row
execute function public.pjsdas_prevent_workspace_schema_downgrade();

comment on function public.pjsdas_prevent_workspace_schema_downgrade() is
  'Prevents stale pre-UU-01 clients from replacing a newer PJSDAS workspace snapshot with an older schema.';
