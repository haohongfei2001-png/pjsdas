import { validateManifest, reviewPurpose, type ReviewManifest } from './review-identities.js'

/** Preparation only. Installing/enabling this Auth hook requires separate approval. */
export function prepareReviewResourceHook(manifest: ReviewManifest, now = Date.now()) {
  validateManifest(manifest, now)
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const deadline = Math.floor(Date.parse(manifest.expiresAt) / 1000)
  const identities = manifest.identities.map(identity => `(
      claims->>'sub' = ${quote(identity.id)}
      and claims->'app_metadata'->>'review_label' = ${quote(identity.label)}
    )`).join(' or ')
  // Pure JSON transformation: no table access, SECURITY DEFINER, external call,
  // client secret, service key, new scope, or business grant.
  const definition = `create function public.pjsdas_review_oauth_resource_hook(event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $hook$
declare claims jsonb := event->'claims';
begin
  if jsonb_typeof(claims) = 'object'
    and event->>'user_id' = claims->>'sub'
    and claims->>'iss' = ${quote(`https://${manifest.project}.supabase.co/auth/v1`)}
    and claims->>'client_id' = ${quote(manifest.clientId)}
    and claims->>'role' = 'authenticated'
    and claims->'aud' in ('"authenticated"'::jsonb, '["authenticated"]'::jsonb)
    and (${identities})
    and claims->'app_metadata'->>'purpose' = ${quote(reviewPurpose)}
    and claims->'app_metadata'->>'review_project' = ${quote(manifest.project)}
    and claims->'app_metadata'->>'review_lease' = ${quote(manifest.leaseId)}
    and claims->'app_metadata'->>'review_client' = ${quote(manifest.clientId)}
    and claims->'app_metadata'->>'review_expires_at' = ${quote(manifest.expiresAt)}
    and extract(epoch from clock_timestamp()) < ${deadline}
    and jsonb_typeof(claims->'exp') = 'number'
  then
    if (claims->>'exp')::numeric = trunc((claims->>'exp')::numeric)
      and (claims->>'exp')::numeric > extract(epoch from clock_timestamp()) then
      claims := jsonb_set(claims, '{aud}', jsonb_build_array('authenticated', ${quote(`${manifest.origin}/api/mcp`)}));
      claims := jsonb_set(claims, '{exp}', to_jsonb(least((claims->>'exp')::numeric, ${deadline})));
    end if;
  end if;
  return jsonb_build_object('claims', claims);
end;
$hook$;`
  const install = `begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $install$ begin
if current_setting('lock_timeout') <> '2s' or current_setting('statement_timeout') <> '15s' then
  raise exception 'Bounded explicit transaction required';
end if;
execute $definition$${definition}$definition$;
revoke all on function public.pjsdas_review_oauth_resource_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.pjsdas_review_oauth_resource_hook(jsonb) to supabase_auth_admin;
end $install$;
commit;
`
  const remove = `begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
do $remove$ begin
if current_setting('lock_timeout') <> '2s' or current_setting('statement_timeout') <> '15s' then
  raise exception 'Bounded explicit transaction required';
end if;
drop function public.pjsdas_review_oauth_resource_hook(jsonb);
end $remove$;
commit;
`
  return { install, remove, uri: 'pg-functions://postgres/public/pjsdas_review_oauth_resource_hook', deadline: manifest.expiresAt }
}
