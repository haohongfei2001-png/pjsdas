/** A cold original HTTP handler; no injected store, reducer, receipt or grant. */
import assert from 'node:assert/strict'
import {verifyConsumerSource,consumerSourceImport} from './consumer-pg-source.mjs'
import {sourceImport} from './workspace-rows-durable-v2-source.mjs'
verifyConsumerSource()
const {PJSDAS_SUPABASE_URL}=await sourceImport('gateway/supabaseProject.ts')
const proxy=new URL(process.env.TA_INTENT_PROXY),nativeFetch=globalThis.fetch
assert.equal(proxy.hostname,'127.0.0.1')
globalThis.fetch=(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,PJSDAS_SUPABASE_URL,'Nonlocal egress forbidden');return nativeFetch(proxy.origin+url.pathname+url.search,init)}
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
const input=JSON.parse(Buffer.concat(chunks).toString())
assert(['/api/health','/api/workspace'].includes(input.path));assert(['GET','POST','OPTIONS'].includes(input.method))
assert.equal(typeof input.rawBody,'string')
const {default:handler}=input.path==='/api/health'?await consumerSourceImport('api/health.ts'):await sourceImport('api/workspace.ts')
const request=new Request('https://todayaction-backend.invalid'+input.path,{method:input.method,headers:input.headers,...(input.rawBody?{body:input.rawBody}:{})})
const response=await handler.fetch(request)
process.stdout.write(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),rawBody:await response.text()}))
