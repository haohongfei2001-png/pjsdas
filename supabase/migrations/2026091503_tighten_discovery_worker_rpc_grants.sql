-- Keep the server-owned discovery RPC surface callable only from the anonymous
-- PostgREST role carrying the independent Vault worker token. Signed-in end-user
-- sessions do not need direct EXECUTE permission on these SECURITY DEFINER RPCs.

revoke execute on function public.pjsdas_claim_discovery_automation_bindings(text) from authenticated;
revoke execute on function public.pjsdas_update_discovery_automation_state(
  text, uuid, timestamptz, timestamptz, text, boolean
) from authenticated;
