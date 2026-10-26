-- Independent, local-only normalized resource sidecar. NOT a migration or RPC.
-- No runtime imports, grants, SECURITY DEFINER functions, existing SQL changes,
-- provider calls, original receipt/Undo copies, or production policy defaults.
create schema ta_resource_reservations;
create table ta_resource_reservations.pool (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null,
  command_limit bigint, owner_limit bigint, global_limit bigint,
  generation text not null,
  revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  inventory_verified boolean not null default false,
  inventory_revision bigint,
  held bigint not null default 0, occupied bigint not null default 0, present bigint not null default 0,
  check(0 <= present and present <= occupied and occupied <= held and held <= 9007199254740991),
  check((not enabled and command_limit is null and owner_limit is null and global_limit is null and held=0)
     or (enabled and command_limit is not null and owner_limit is not null and global_limit is not null and command_limit between 0 and 9007199254740991
         and owner_limit between 0 and 9007199254740991 and global_limit between 0 and 9007199254740991
         and held <= global_limit))
);
create table ta_resource_reservations.owner (
  user_id text primary key,
  held bigint not null default 0, occupied bigint not null default 0, present bigint not null default 0,
  check(0 <= present and present <= occupied and occupied <= held and held <= 9007199254740991)
);
create table ta_resource_reservations.reservation (
  stage_id text primary key,
  user_id text not null references ta_resource_reservations.owner,
  command_id text not null,
  binding jsonb not null check(jsonb_typeof(binding)='object'),
  reserved bigint not null check(reserved between 1 and 9007199254740991),
  expires_at bigint not null check(expires_at between 0 and 9007199254740991),
  deadline_at bigint not null check(deadline_at between 0 and 9007199254740991),
  phase text not null default 'open' check(phase in ('open','stopped','finalizing','unknown','committed','not-committed','reclaiming','released')),
  revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  occupied bigint not null default 0, present bigint not null default 0,
  finalize_attempt text, stop_reason text, outcome jsonb,
  reclaim_id text, writer_fence text, writer_fence_revision bigint,
  reclaim_inventory_revision bigint,
  unique(user_id,command_id),
  check(binding ?& array['stageId','userId','commandId'] and (binding->>'stageId') is not distinct from stage_id and (binding->>'userId') is not distinct from user_id and (binding->>'commandId') is not distinct from command_id),
  check(0 <= present and present <= occupied and occupied <= reserved),
  check(phase <> 'released' or (occupied=0 and present=0)),
  check((phase in ('reclaiming','released')) = (reclaim_id is not null and writer_fence is not null and writer_fence_revision is not null and reclaim_inventory_revision is not null)),
  check((phase in ('committed','not-committed','reclaiming','released')) = (outcome is not null)),
  check(phase not in ('finalizing','unknown') or finalize_attempt is not null)
);
create table ta_resource_reservations.allocation (
  stage_id text not null references ta_resource_reservations.reservation,
  allocation_id text not null,
  kind text not null check(kind in ('intent-encoded','intent-decoded','document-fragments','effect-wire','effect-jsonb','audit-spool','storage-overhead')),
  next_offset bigint not null default 0 check(next_offset between 0 and 9007199254740991),
  occupied bigint not null default 0, present bigint not null default 0,
  removed boolean not null default false,
  primary key(stage_id,allocation_id),
  check(0 <= present and present <= occupied and occupied <= next_offset),
  check(not removed or (occupied=0 and present=0))
);
create table ta_resource_reservations.chunk (
  stage_id text not null, allocation_id text not null,
  byte_offset bigint not null check(byte_offset between 0 and 9007199254740991),
  bytes bigint not null check(bytes between 1 and 9007199254740991),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check(status in ('pending','present')),
  primary key(stage_id,allocation_id,byte_offset),
  foreign key(stage_id,allocation_id) references ta_resource_reservations.allocation
);
-- This namespace is ONLY temporary sidecar-owned copies. No original business
-- ledger or audit data may be placed here. Kept independent from chunk FK so the
-- fenced inventory can demonstrate detection of unknown physical bytes.
create table ta_resource_reservations.temporary_bytes (
  stage_id text not null, allocation_id text not null, byte_offset bigint not null,
  data bytea not null,
  primary key(stage_id,allocation_id,byte_offset)
);
-- Deliberately no DELETE on reservation/owner/chunk tombstones in the adapter.
-- Metadata retention/compaction and physical PostgreSQL storage/WAL sizing are
-- separate unapproved policies; logical byte counters are not disk guarantees.
