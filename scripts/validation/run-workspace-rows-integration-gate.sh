#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
E=${TA_INTEGRATED_EVIDENCE_DIR:-"$ROOT/.ta-validation/runs"}
gate=${1:?gate}; run=${2:?unique lowercase run id}
[[ "$gate" =~ ^[a-z0-9-]+$ && "$run" =~ ^[a-z0-9-]+$ ]] || exit 64
[[ ${TA_INTEGRATED_VALIDATION_WINDOW:-} == authorized-by-parent ]] || exit 69
SHA=${TA_INTEGRATED_SOURCE_SHA:?frozen exact source SHA required}
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || exit 64
exec 9>"${TA_INTEGRATED_LOCK_FILE:-${TMPDIR:-/tmp}/ta-staged-operations-20261026.lock}"
flock -n 9 || { echo 'another owned gate is active; no takeover'; exit 70; }
[[ "$E" = /* ]] || { echo 'evidence directory must be absolute'; exit 64; }
mkdir -p "$E"
OUT="$E/$gate-$run";mkdir "$OUT"
cd "$ROOT"
test "$(git rev-parse HEAD)" = "$SHA"
git diff --exit-code HEAD -- .
# Freeze this exact clean checkout, not a private sibling evidence catalog.
git ls-files -z | xargs -0 sha256sum > "$OUT/frozen-source.sha256"
sha256sum -c "$OUT/frozen-source.sha256" > "$OUT/source-before.log"
# Ambient product/test credentials and selectors are never inherited as policy.
while IFS= read -r key;do unset "$key";done < <(compgen -A variable | grep -E '^(PJSDAS_|PGRST_|TA_ROW_|TA_AUDIT_|TA_PAIR_|TA_INTENT_)' || true)
started=0;start_attempted=0;PG="";DATA="$OUT/owned-pg-data";port=55634
printf '{"event":"start","gate":"%s","run":"%s","sha":"%s","at":"%s"}\n' "$gate" "$run" "$SHA" "$(date -u +%FT%TZ)" >> "$E/command-ledger.jsonl"
finish(){
 rc=$?;set +e
 if [ "$start_attempted" = 1 ];then
  if [ "$started" = 1 ];then
   node scripts/validation/workspace-rows-integration-inventory.mjs inventory "$port" > "$OUT/final-inventory.json" 2>&1 || rc=75
  fi
  # pg_ctl -w may fail while its owned postmaster is still starting. Always
  # attempt to stop this exact DATA after a start attempt, not only after ACK.
  "$PG" -D "$DATA" stop -m fast -w > "$OUT/pg-stop.log" 2>&1 || rc=74
 fi
 if [ "$gate" = build ] && ! git diff --quiet HEAD -- gateway/generatedReleaseIdentity.ts;then
  cp gateway/generatedReleaseIdentity.ts "$OUT/generatedReleaseIdentity.ts"
  git show HEAD:gateway/generatedReleaseIdentity.ts > gateway/generatedReleaseIdentity.ts
 fi
 sha256sum -c "$OUT/frozen-source.sha256" > "$OUT/source-after.log" 2>&1 || rc=72
 git diff --exit-code HEAD -- . > "$OUT/tracked-diff.log" 2>&1 || rc=72
 test "$(git rev-parse HEAD)" = "$SHA" || rc=72
 printf '{"event":"end","gate":"%s","run":"%s","exit":%s,"at":"%s"}\n' "$gate" "$run" "$rc" "$(date -u +%FT%TZ)" >> "$E/command-ledger.jsonl"
 printf '%s\n' "$rc" > "$OUT/exit-code.txt"
 exit "$rc"
}
trap finish EXIT
start_pg(){
 local pgdir=${TA_POSTGRES_BIN_DIR:?set TA_POSTGRES_BIN_DIR to a verified PostgreSQL 17 bin directory}
 PG="$pgdir/pg_ctl"
 test -x "$PG" && test -x "$pgdir/initdb"
 [[ $("$PG" --version) == *"(PostgreSQL) 17."* ]] || { echo 'PostgreSQL 17 required'; exit 64; }
 test -x "${TA_POSTGREST_BIN:?set TA_POSTGREST_BIN to a verified official PostgREST binary}"
 if [ -f "$DATA/PG_VERSION" ];then
  if "$PG" -D "$DATA" status >/dev/null 2>&1;then echo 'unexpected running owned PG; refusing takeover';exit 71;fi
 else
  "$pgdir/initdb" -D "$DATA" -U postgres --auth-local=trust --auth-host=trust --no-locale --encoding=UTF8 > "$OUT/initdb.log"
 fi
 start_attempted=1
 "$PG" -D "$DATA" -l "$OUT/pg-server.log" -o "-h 127.0.0.1 -p $port -k \"\" -c work_mem=2184kB" -w start
 started=1
 node scripts/validation/workspace-rows-integration-inventory.mjs init "$port"
 export TA_ROW_DATABASE_URL="postgres://postgres@127.0.0.1:$port/postgres"
}
case "$gate" in
 focused) node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism tests/workspaceRowsResourceAccounting.test.ts tests/workspaceRowsDurableRecovery.test.ts tests/workspaceRowsPagesReleaseProfile.test.ts tests/workspaceRowsAuditPages.test.ts tests/workspaceRowsAuditBytes.test.ts tests/workspaceRowsCandidate.test.ts tests/workspaceRowsRuntime.test.ts tests/workspaceRowsStagedBridge.test.ts tests/workspaceRowsDurableIntent.test.ts tests/workspaceRowsDurableIntentEntry.test.ts tests/workspaceRowsStagedOpportunity.test.ts > "$OUT/output.log" 2>&1;;
 tsc) node node_modules/typescript/bin/tsc -b > "$OUT/output.log" 2>&1;;
 unit) node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism > "$OUT/output.log" 2>&1;;
 build)
  PJSDAS_RELEASE_COMMIT_SHA="$SHA" npm run build > "$OUT/output.log" 2>&1
  cp gateway/generatedReleaseIdentity.ts dist/release-manifest.json "$OUT/"
  node_modules/.bin/esbuild api/workspace.ts --bundle --platform=node --packages=external --format=esm --outfile="$OUT/workspace-api.mjs" >> "$OUT/output.log" 2>&1
  node_modules/.bin/esbuild gateway/scopedManagementRuntime.ts --bundle --platform=node --packages=external --format=esm --outfile="$OUT/scoped-management.mjs" >> "$OUT/output.log" 2>&1
  node scripts/validation/workspace-rows-integration-verify-artifact.mjs "$ROOT" "$OUT" "$SHA" >> "$OUT/output.log" 2>&1;;
 install) start_pg;node --import tsx tests/sql/workspace-rows-integrated-install.mjs > "$OUT/output.log" 2>&1;;
 resource-pg) port=55439;start_pg;node --import tsx tests/sql/workspace-rows-resource-reservations-native.mjs > "$OUT/output.log" 2>&1;;
 resource-rpc) start_pg;node --import tsx tests/sql/workspace-rows-resource-rpc-native.mjs > "$OUT/output.log" 2>&1;;
 resource-rpc-audit|resource-rpc-pages)
  start_pg;export TA_ROW_AUDIT_PROOF=1 TA_AUDIT_MEASURE_REPORT="$OUT/audit-measure.json"
  if [ "$gate" = resource-rpc-pages ];then export TA_ROW_AUDIT_PAGES_PROOF=1;fi
  node --import tsx tests/sql/workspace-rows-resource-rpc-native.mjs > "$OUT/output.log" 2>&1;;
 resource-recovery-integrated|resource-recovery-r0p)
  start_pg;export TA_INTEGRATION_RECOVERY_TARGET=${gate#resource-recovery-}
  node --import tsx tests/sql/workspace-rows-integrated-resource-recovery-native.mjs > "$OUT/output.log" 2>&1;;
 pair)
  start_pg;export TA_INTEGRATED_PAIR_REPORT="$OUT/pair-result.json"
  node --import tsx tests/sql/integrated-pair-harness.mjs > "$OUT/output.log" 2>&1
  node --input-type=module - "$OUT" <<'JS' >> "$OUT/output.log" 2>&1
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const root=process.argv[2],read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const pair=read('pair-result.json'),runner=read('runner-state.json');
assert.equal(pair.cases.length,81);assert(pair.cases.every(x=>x.status==='PASS'));assert.equal(new Set(pair.cases.map(x=>x.label)).size,81);
assert.equal(pair.pageReadyPair,'PASS_LOCAL_CROSS_PROFILE_AND_HISTORICAL_THREE_MODE');assert.equal(runner.status,'PASS');assert.equal(runner.cleanupComplete,true);assert.equal(runner.proxyInFlight,0);
console.log('PASS_EXACT_81_AND_TERMINAL_CLEANUP');
JS
  ;;
 narrow-reader-only)
  start_pg;TA_ROW_READER_FIXTURE=1 node --import tsx tests/sql/workspace-rows-resource-rpc-native.mjs > "$OUT/output.log" 2>&1;;
 matrix) start_pg;TA_ROW_ROLLBACK_FIXTURE=1 node --import tsx tests/sql/workspace-rows-stage-a.mjs > "$OUT/output.log" 2>&1;;
 guard-equivalence) start_pg;node --import tsx tests/sql/workspace-rows-opportunity-guard-equivalence.mjs > "$OUT/output.log" 2>&1;;
 equivalence) start_pg;node --import tsx tests/sql/workspace-rows-finalizer-equivalence.mjs > "$OUT/output.log" 2>&1;;
 finalizer-plan) start_pg;TA_PLAN_REPORT="$OUT/finalizer-plans.json" node --import tsx tests/sql/workspace-rows-finalizer-plan.mjs > "$OUT/output.log" 2>&1;;
 oldlarge) start_pg;node --import tsx tests/sql/workspace-rows-large-command-prototype.mjs > "$OUT/output.log" 2>&1;;
 oldv3) start_pg;node --import tsx tests/sql/workspace-rows-staged-opportunity-prototype.mjs > "$OUT/output.log" 2>&1;;
 *) echo 'unknown gate';exit 64;;
esac
