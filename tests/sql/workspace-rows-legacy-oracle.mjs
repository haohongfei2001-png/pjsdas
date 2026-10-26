import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** Separate synthetic owner for differential legacy execution. Sharing an owner
 * and command IDs would make the second implementation a replay, not an oracle.
 * Only owner/grant UUIDs differ; business input, authorization state and command
 * identity stay identical. Original grant lifecycle/race tests use the real grant,
 * not this snapshot copy. Never called against a non-disposable database. */
export async function createLegacyManagementOracle(db, userId, snapshot) {
  const owner = randomUUID(), grants = new Map()
  await db.query('insert into auth.users(id) values($1)', [owner])
  const workspaceId = (await db.query('insert into public.pjsdas_workspaces(user_id,snapshot,schema_version) values($1,$2,4) returning id', [owner, snapshot])).rows[0].id
  return {
    owner, workspaceId,
    async query(sql, values) {
      assert(/^select \* from public\.pjsdas_commit_[a-z0-9_]+\(/.test(sql), 'only the existing legacy management oracle RPC')
      const args = [...values], grantIndex = args.length - 2, originalGrant = args[grantIndex]
      const existing = (await db.query('select * from public.pjsdas_business_management_grants where id=$1', [originalGrant])).rows[0]
      if (args[0] === userId) args[0] = owner
      if (existing?.user_id === userId) {
        const mirrorId = grants.get(originalGrant) ?? randomUUID(); grants.set(originalGrant, mirrorId)
        // Recreate only this synthetic oracle's grant so its complete current
        // revision/revocation snapshot equals the tested grant, without changing
        // either production semantics or the candidate's original grant.
        await db.query('delete from public.pjsdas_business_management_grants where id=$1', [mirrorId])
        await db.query('insert into public.pjsdas_business_management_grants select * from jsonb_populate_record(null::public.pjsdas_business_management_grants,$1)', [{ ...existing, id: mirrorId, user_id: owner }])
        args[grantIndex] = mirrorId
      }
      const result = await db.query(sql, args)
      // Normalize only the explicitly mapped fixture UUID for differential
      // comparison; first assert the real RPC bound the correct oracle grant.
      for (const row of result.rows) if (row.receipt?.managementAuthorization) {
        assert.equal(row.receipt.managementAuthorization.grantId, args[grantIndex])
        row.receipt = { ...row.receipt, managementAuthorization: { ...row.receipt.managementAuthorization, grantId: originalGrant } }
      }
      return result
    },
    async setSnapshot(value, incrementRevision = false) {
      await db.query(`update public.pjsdas_workspaces set snapshot=$2${incrementRevision ? ',revision=revision+1,materialized_revision=revision+1' : ''} where id=$1`, [workspaceId, value])
    },
  }
}
