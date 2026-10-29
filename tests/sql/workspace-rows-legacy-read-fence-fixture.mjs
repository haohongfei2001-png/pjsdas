/** Isolated fixture installer, NOT a dynamic production migration. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
/** Additive RPC contract only, for pre-fence historical Stage-A tests. Those
 * tests intentionally retain old ACL behavior; this does NOT count as a read
 * retirement proof. The separate real-entry test installs the full ACL fence.
 * Pre-row historical schemas lack row_candidate_epoch; any present non-null
 * epoch still fails closed, with the same service-role and owner checks. */
export async function installLegacyReadBridgeOnlyFixture(db) {
  await db.query(`create function public.pjsdas_read_legacy_workspace_v1(target_user_id uuid)
  returns setof public.pjsdas_workspaces language plpgsql stable security invoker set search_path=pg_catalog as $$
  declare w public.pjsdas_workspaces;caller_user uuid;
  begin
   if current_setting('role',true) is distinct from 'service_role' then raise exception 'server reader only' using errcode='42501';end if;
   caller_user:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid;
   if caller_user is not null and caller_user is distinct from target_user_id then raise exception 'owner mismatch' using errcode='42501';end if;
   if target_user_id is null then raise exception 'owner required' using errcode='22023';end if;
   select * into w from public.pjsdas_workspaces where user_id=target_user_id;
   if not found then return;end if;
   if to_jsonb(w)->>'row_candidate_epoch' is not null then raise exception 'active generation requires row reader' using errcode='PT409';end if;
   return next w;
  end$$;
  revoke all on function public.pjsdas_read_legacy_workspace_v1(uuid) from public,anon,authenticated;
  grant execute on function public.pjsdas_read_legacy_workspace_v1(uuid) to service_role;`)
}
export async function installLegacyReadFenceFixture(db) {
  const changes = JSON.parse(readFileSync(new URL('./legacy-read-fence-substitutions.json', import.meta.url), 'utf8'))
  assert.equal(changes.length, 9)
  const definitions = []
  for (const change of changes) {
    const row = (await db.query('select pg_get_functiondef($1::regprocedure) definition', ['public.' + change.signature])).rows[0]
    assert.equal(row.definition.split(change.old).length, 2, 'exact original fixture preimage: ' + change.signature)
    definitions.push(row.definition.replace(change.old, change.replacement) + ';')
  }
  const template = readFileSync(new URL('./candidates/workspace-rows-legacy-read-fence-prototype.sql', import.meta.url), 'utf8')
  // Function bodies contain SQL regex end anchors (`$'`). A string replacement
  // would interpret those as JavaScript replacement tokens and corrupt SQL.
  await db.query(template.replace('-- Insert the 9 reviewed static INVOKER definitions before COMMIT.', () => definitions.join('\n')))
}
