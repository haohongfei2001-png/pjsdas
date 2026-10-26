import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs'
import {join,relative} from 'node:path'
import assert from 'node:assert/strict'
const [root,output,sha]=process.argv.slice(2),dist=join(root,'dist')
assert(/^([a-f0-9]{40})$/.test(sha))
function filesUnder(root){return readdirSync(root).filter(n=>n!=='release-manifest.json').flatMap(n=>{const p=join(root,n);return statSync(p).isDirectory()?filesUnder(p):[p]})}
const entries=filesUnder(dist).sort((a,b)=>relative(dist,a).localeCompare(relative(dist,b))).map(path=>({path:relative(dist,path).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),hash=createHash('sha256')
for(const file of entries)hash.update(file.path+'\0'+file.sha256+'\n')
const digest='sha256:'+hash.digest('hex'),manifest=JSON.parse(readFileSync(join(dist,'release-manifest.json'),'utf8'))
assert.equal(manifest.commitSha,sha);assert.equal(manifest.frontendArtifactDigest,digest)
const backend={}
for(const file of ['workspace-api.mjs','scoped-management.mjs','generatedReleaseIdentity.ts'])backend[file]=createHash('sha256').update(readFileSync(join(output,file))).digest('hex')
assert(readFileSync(join(output,'generatedReleaseIdentity.ts'),'utf8').includes(JSON.stringify(sha)))
const result={sourceCommit:sha,localOnly:true,hosted:false,frontendArtifactDigest:digest,frontendFiles:entries,backendArtifacts:backend,releaseProfileSourceSha256:createHash('sha256').update(readFileSync(join(root,'gateway/workspaceRowsReleaseProfile.ts'))).digest('hex')}
writeFileSync(join(output,'artifact-verification.json'),JSON.stringify(result,null,2)+'\n')
console.log('PASS FROZEN_ARTIFACT',JSON.stringify({sha,digest,files:entries.length,backend}))
