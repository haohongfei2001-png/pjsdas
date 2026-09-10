-- PJSDAS v1.0: one private cloud workspace per authenticated user.
-- Run this in the Supabase SQL editor. The browser must only receive the
-- Publishable/anon key; never expose a service_role key to GitHub Pages.

create table if not exists public.pjsdas_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  schema_version integer not null default 1 check (schema_version > 0),
  fingerprint text not null,
  snapshot jsonb not null,
  updated_by_device text not null,
  updated_at timestamptz not null default now()
);

alter table public.pjsdas_workspaces enable row level security;

revoke all on table public.pjsdas_workspaces from anon, authenticated;
grant select, insert, update, delete on table public.pjsdas_workspaces to authenticated;

drop policy if exists "pjsdas_workspace_select_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_select_own"
on public.pjsdas_workspaces for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_insert_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_insert_own"
on public.pjsdas_workspaces for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_update_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_update_own"
on public.pjsdas_workspaces for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "pjsdas_workspace_delete_own" on public.pjsdas_workspaces;
create policy "pjsdas_workspace_delete_own"
on public.pjsdas_workspaces for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
