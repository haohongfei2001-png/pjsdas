import { MOCK_TARGET_AUTH_KEY } from './support/mockCloudTargets.js'
import { SCOPED_MANAGEMENT_CONSENTS, scopedManagementConsentHash, type ScopedManagementDomain } from '../gateway/scopedManagementConsent.js'
import { expect, test, type Page, type Route } from '@playwright/test'
const owner='00000000-0000-4000-8000-000000000001', clientId='00000000-0000-4000-8000-000000000002'
const entry='/pjsdas/?connect=1'
// Multi-domain fixtures retain historical component recovery/atomic-batch regressions.
// Controlled consumer admission is tested separately below with business-only descriptors.
const descriptors=Object.entries(SCOPED_MANAGEMENT_CONSENTS).map(([domain,consent])=>({domain,canApprove:true,consentTextHash:'a'.repeat(64),consent}))
async function json(route:Route,body:unknown,status=200){await route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'authorization, content-type','access-control-allow-methods':'GET, POST, OPTIONS','cache-control':'no-store'},body:JSON.stringify(body)})}
async function fixture(page:Page,unknownFirst=false,options:{neverCommitted?:boolean;expired?:boolean;holdPost?:Promise<void>}={}){
 const viewDescriptors=await Promise.all(descriptors.map(async d=>({...d,consentTextHash:await scopedManagementConsentHash(d.domain as ScopedManagementDomain)})))
 const state={canInitialize:true,account:{id:owner,email:'synthetic@example.invalid'},descriptors:viewDescriptors,clients:[{id:clientId,name:'Synthetic client',canApprove:true,grants:[] as any[]}]}
 const posts:any[]=[],initializations:any[]=[],receipts=new Map<string,unknown>();let expired=Boolean(options.expired),viewState=state
 await page.addInitScript(({owner,authKey})=>{localStorage.setItem(authKey,JSON.stringify({access_token:'synthetic-session',refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:86400,expires_at:Math.floor(Date.now()/1000)+86400,user:{id:owner,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',app_metadata:{provider:'google',providers:['google']},user_metadata:{sub:owner},identities:[],created_at:'2026-10-01T00:00:00Z'}}))},{owner,authKey:MOCK_TARGET_AUTH_KEY})
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort())
 await page.route('**/api/health',route=>json(route,{status:'ok',version:'1.10.0-alpha.1',workspaceAuthority:'transactional',mode:'transactional-connected',capabilities:{deploymentPortability:true}}))
 await page.route('**/api/workspace',async route=>{if(route.request().method()==='OPTIONS')return json(route,{});if(route.request().method()==='GET')return json(route,{code:'WORKSPACE_MIGRATION_REQUIRED'},409);const b=route.request().postDataJSON();if(b.action==='read')return json(route,{code:'WORKSPACE_MIGRATION_REQUIRED'},409);expect(b.action).toBe('initialize_empty');initializations.push(b);expect(b.expectedAccountId).toBe(owner);expect(b.confirmStartEmpty).toBe(true);return json(route,{outcome:'INITIALIZED_OR_EXISTING',workspaceId:'synthetic-workspace'})})
 await page.route('**/api/workspace?surface=scoped-management-consent',async route=>{
  if(route.request().method()==='OPTIONS')return json(route,{})
  if(expired)return json(route,{code:'AUTH_REQUIRED'},401)
  if(route.request().method()==='GET')return json(route,viewState)
  const b=route.request().postDataJSON();posts.push(b);expect(b.expectedAccountId).toBe(owner);expect(b.clientId).toBe(clientId)
  if(options.holdPost)await options.holdPost
  if(options.neverCommitted&&posts.length===1)return json(route,{code:'CONSENT_OUTCOME_UNCONFIRMED'},502)
  if(options.neverCommitted&&posts.length===2)return json(route,{code:'CONSENT_CONFLICT'},409)
  if(!receipts.has(b.requestId)){
   const values=b.choices.map((choice:any)=>{
    const d=state.descriptors.find(x=>x.domain===choice.domain)!,old=state.clients[0].grants.find(x=>x.domain===choice.domain)
    const grant={domain:choice.domain,id:old?.id??'00000000-0000-4000-8000-000000000003',client_id:clientId,revision:(old?.revision??0)+1,revoked_at:choice.decision==='revoke'?'2026-10-03T00:00:00Z':null,consent_version:d.consent.version,capability:d.consent.capability,consent_text_hash:d.consentTextHash}
    state.clients[0].grants=state.clients[0].grants.filter(x=>x.domain!==choice.domain).concat(grant)
    return {domain:choice.domain,outcome:choice.decision==='approve'?'APPROVED':'REVOKED',grant_id:grant.id,grant_revision:grant.revision}
   });receipts.set(b.requestId,{requestId:b.requestId,receipts:values,refreshRequired:true})
  }
  if(unknownFirst&&posts.length===1)return json(route,{code:'CONSENT_OUTCOME_UNCONFIRMED'},502)
  return json(route,receipts.get(b.requestId))
 })
 return {posts,initializations,state,setExpired:(value:boolean)=>{expired=value},setView:(value:typeof state)=>{viewState=value}}
}
test('fresh empty workspace and explicit single-domain approve/revoke leave neighbors unchanged',async({page})=>{
 const f=await fixture(page);await page.goto(entry)
 await page.getByLabel('选择已连接客户端').selectOption(clientId)
 for(const d of descriptors)await expect(page.getByLabel(`本次选择：${d.domain==='planning'?'时间偏好':d.consent.title}`)).toHaveValue('')
 const planning=page.getByRole('group',{name:'时间偏好',exact:true})
 await expect(planning.getByText('当前仅支持读取、修改、重置时间偏好及撤销相关修改。评分与决策策略已退役。')).toBeVisible()
 await expect(planning.getByText('读取、修改、重置决策规则及时间偏好',{exact:true})).not.toBeVisible()
 await planning.getByText('查看 v4 授权原文',{exact:true}).click()
 await expect(planning.getByText('读取、修改、重置决策规则及时间偏好',{exact:true})).toBeVisible()
 await planning.getByText('查看 v4 授权原文',{exact:true}).click()
 await expect(page.getByRole('button',{name:'确认所选变更'})).toBeDisabled()
 for(const [width,height]of [[1280,900],[390,844]]){await page.setViewportSize({width,height});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await test.info().attach(`consumer-default-none-${width}`,{body:await page.screenshot({fullPage:true}),contentType:'image/png'})}
 await page.setViewportSize({width:1280,height:900})
 await page.getByLabel('工作区时区',{exact:true}).fill('America/New_York')
 await page.getByLabel('我明确选择从空工作区开始，并已核对当前账号及上述时区。').check()
 await page.getByRole('button',{name:'准备我的工作区',exact:true}).click()
 await expect(page.getByText('工作区已准备好；已有数据不会被重置。现在可选择此客户端的分项权限。')).toBeVisible()
 expect(f.initializations).toHaveLength(1);expect(f.initializations[0].timezone).toBe('America/New_York')
 await page.getByLabel('本次选择：时间偏好').selectOption('approve')
 await test.info().attach('consumer-exact-planning-choice',{body:await page.screenshot({fullPage:true}),contentType:'image/png'})
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check()
 await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。')).toBeVisible()
 expect(f.posts[0].choices.map((x:any)=>x.domain)).toEqual(['planning'])
 expect(f.posts[0].choices[0]).toMatchObject({consentVersion:4,consentTextHash:'8d00011548bd7cd023b8993127be68a68b10c148a769b0ce66dc456b02590ee8'})
 await page.getByLabel('本次选择：时间偏好').selectOption('revoke')
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check()
 await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect.poll(()=>f.posts.length).toBe(2)
 expect(f.posts[1].choices[0].expectedGrant.revision).toBe(1)
 expect(f.state.clients[0].grants).toHaveLength(1)
 expect(f.state.clients[0].grants[0].revoked_at).not.toBeNull()
})
test('ambiguous batch response preserves exact choices across reload and same-ID retry',async({page})=>{
 const f=await fixture(page,true);await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('本次选择：应用内私人提醒').selectOption('approve')
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByRole('button',{name:'重试同一请求'})).toBeDisabled();const submitted=structuredClone(f.posts[0])
 await page.reload();await expect(page.getByRole('button',{name:'重试同一请求'})).toBeEnabled();await page.getByRole('button',{name:'重试同一请求'}).click()
 await expect.poll(()=>f.posts.length).toBe(2);expect(f.posts[1]).toEqual(submitted)
 expect(f.state.clients[0].grants.every(g=>g.revision===1)).toBe(true)
 await page.goto('about:blank') // Settle the mocked document before context teardown.
})

test('committed approval receipt remains recoverable after disconnect, then revoke stays available',async({page})=>{
 const f=await fixture(page,true);await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByRole('button',{name:'重试同一请求'})).toBeDisabled();const submitted=structuredClone(f.posts[0]);f.state.clients[0].canApprove=false
 await page.reload();await page.getByRole('button',{name:'重试同一请求'}).click();await expect.poll(()=>f.posts.length).toBe(2);expect(f.posts[1]).toEqual(submitted)
 await expect(page.getByRole('button',{name:'重试同一请求'})).toHaveCount(0)
 await page.getByLabel('本次选择：时间偏好').selectOption('revoke');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click();await expect.poll(()=>f.posts.length).toBe(3)
 expect(f.state.clients[0].grants).toHaveLength(1);expect(f.state.clients[0].grants[0].revoked_at).not.toBeNull()
})
test('definitive stale CAS clears an uncertain retry and permits a new explicit choice',async({page})=>{
 const f=await fixture(page,false,{neverCommitted:true});await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByRole('button',{name:'重试同一请求'})).toBeDisabled();await page.reload();await page.getByRole('button',{name:'重试同一请求'}).click()
 await expect(page.getByRole('button',{name:'重试同一请求'})).toHaveCount(0)
 await expect(page.getByLabel('本次选择：时间偏好')).toBeEnabled();await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect.poll(()=>f.posts.length).toBe(3);expect(f.posts[2].requestId).not.toBe(f.posts[0].requestId);expect(f.state.clients[0].grants).toHaveLength(1)
})
test('expired cached session exposes login and preserves pending request for authenticated recovery',async({page})=>{
 const f=await fixture(page,true);await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByRole('button',{name:'重试同一请求'})).toBeDisabled();const submitted=structuredClone(f.posts[0]);f.setExpired(true);await page.reload()
 await expect(page.getByRole('button',{name:'使用 Google 登录 TodayAction'})).toBeVisible();f.setExpired(false);await page.getByRole('button',{name:'重新读取状态'}).click()
 await page.getByRole('button',{name:'重试同一请求'}).click();await expect.poll(()=>f.posts.length).toBe(2);expect(f.posts[1]).toEqual(submitted)
})

test('repeated submit while a request is outstanding sends one immutable decision',async({page})=>{
 let release!:()=>void;const holdPost=new Promise<void>(resolve=>{release=resolve}),f=await fixture(page,false,{holdPost});await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check()
 await page.getByRole('button',{name:'确认所选变更'}).evaluate((element:HTMLButtonElement)=>{element.click();element.click()})
 await expect.poll(()=>f.posts.length).toBe(1);await expect(page.getByRole('button',{name:'确认所选变更'})).toBeDisabled();release()
 await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。')).toBeVisible();expect(f.posts).toHaveLength(1)
})
test('Close and Back/Forward discard unsubmitted scope choices without issuing grants',async({page})=>{
 const f=await fixture(page);await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId);await page.getByLabel('本次选择：时间偏好').selectOption('approve')
 await page.getByRole('button',{name:'返回 TodayAction',exact:true}).click();await expect(page).not.toHaveURL(/connect=1|scoped_access=1/)
 await page.goBack();await expect(page.getByRole('heading',{name:'选择这个客户端可以管理什么'})).toBeVisible();await expect(page.getByRole('button',{name:'确认所选变更'})).toBeDisabled()
 await page.goForward();await expect(page).not.toHaveURL(/connect=1|scoped_access=1/);await page.goBack();await page.getByLabel('选择已连接客户端').selectOption(clientId)
 for(const d of descriptors)await expect(page.getByLabel(`本次选择：${d.domain==='planning'?'时间偏好':d.consent.title}`)).toHaveValue('')
 expect(f.posts).toEqual([])
})
test('account switch during POST never displays the old receipt as the new account state',async({page})=>{
 let release!:()=>void;const holdPost=new Promise<void>(resolve=>{release=resolve}),f=await fixture(page,false,{holdPost}),other='00000000-0000-4000-8000-000000000009'
 await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId);await page.getByLabel('本次选择：时间偏好').selectOption('approve');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click();await expect.poll(()=>f.posts.length).toBe(1)
 f.setView({...f.state,account:{id:other,email:'other@example.invalid'},clients:[]})
 await page.route('**/auth/v1/user',route=>json(route,{id:other,aud:'authenticated',role:'authenticated',email:'other@example.invalid',app_metadata:{provider:'google'},user_metadata:{},identities:[],created_at:'2026-10-01T00:00:00Z'}))
 await page.evaluate(async other=>{
  const {pjsdasSupabase}=await import('/pjsdas/src/aiAccess/supabaseClient.ts')
  const encode=(value:unknown)=>btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')
  const access_token=`${encode({alg:'RS256',typ:'JWT'})}.${encode({sub:other,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'})}.${encode('synthetic-signature')}`
  const result=await pjsdasSupabase.auth.setSession({access_token,refresh_token:'synthetic-other-refresh'});if(result.error)throw result.error
 },other)
 release();await expect(page.getByText('other@example.invalid',{exact:true})).toBeVisible();await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。')).toHaveCount(0)
 await expect(page.getByRole('button',{name:'确认所选变更'})).toBeDisabled();expect(f.posts).toHaveLength(1);expect(f.posts[0].expectedAccountId).toBe(owner)
})

test('consumer business permission is an explicit separate choice and revoked in the same bounded batch',async({page})=>{
 const f=await fixture(page);await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await expect(page.getByLabel('本次选择：独立准备、手动行动与投递组')).toHaveValue('')
 await page.getByLabel('本次选择：独立准备、手动行动与投递组').selectOption('approve')
 await page.getByLabel('本次选择：时间偏好').selectOption('approve')
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。')).toBeVisible()
 expect(f.posts[0].choices.map((c:any)=>c.domain)).toEqual(['business','planning'])
 expect(f.posts[0].choices[0]).toMatchObject({consentVersion:7,expectedGrant:null})
 expect(f.state.clients[0].grants.map(g=>g.domain).sort()).toEqual(['business','planning'])
 await page.getByLabel('本次选择：独立准备、手动行动与投递组').selectOption('revoke');await page.getByLabel('本次选择：时间偏好').selectOption('revoke')
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect.poll(()=>f.posts.length).toBe(2);expect(f.posts[1].choices.every((c:any)=>c.decision==='revoke'&&c.expectedGrant.revision===1)).toBe(true)
})

test('stale business consent text is not shown as current authority and remains revocable',async({page})=>{
 const f=await fixture(page),d=f.state.descriptors.find(d=>d.domain==='business')!
 f.state.clients[0].grants.push({domain:'business',id:'00000000-0000-4000-8000-000000000093',client_id:clientId,revision:3,revoked_at:null,consent_version:7,capability:d.consent.capability,consent_text_hash:'0'.repeat(64)})
 await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await expect(page.getByText('当前状态：授权文本已变更，需要重新明确确认；仍可撤销旧授权')).toBeVisible()
 await expect(page.getByText('最近读取的状态：0 项有效授权')).toBeVisible()
 await expect(page.getByLabel('本次选择：独立准备、手动行动与投递组')).toHaveValue('')
 await page.getByLabel('本次选择：独立准备、手动行动与投递组').selectOption('revoke');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect.poll(()=>f.posts.length).toBe(1);expect(f.posts[0].choices[0]).toMatchObject({domain:'business',decision:'revoke',expectedGrant:{revision:3}})
})

// Native <option> disabledness is checked via its DOM property; the generic ARIA/actionability
// matcher did not reflect this flag in the captured failures. Keep exact option and submitted-scope checks.
for (const width of [1280,390]) test(`all consumer flags off retains owned revocation and hides onboarding at ${width}`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:900})
 const f=await fixture(page),d=f.state.descriptors.find(d=>d.domain==='business')!
 f.state.canInitialize=false;f.state.clients[0].canApprove=false
 for(const descriptor of f.state.descriptors)descriptor.canApprove=false
 f.state.clients[0].grants.push({domain:'business',id:'00000000-0000-4000-8000-000000000093',client_id:clientId,revision:3,revoked_at:null,consent_version:d.consent.version,capability:d.consent.capability,consent_text_hash:d.consentTextHash})
 await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 await expect(page.getByText('当前不能新增管理授权；已有权限仍可查看和撤销。')).toBeVisible()
 await expect(page.getByText('第一次使用 TodayAction')).toHaveCount(0)
 const choice=page.getByLabel('本次选择：独立准备、手动行动与投递组')
 await expect(choice.getByRole('option',{name:'明确授权此项',exact:true})).toHaveJSProperty('disabled',true)
 await expect(choice.getByRole('option',{name:'撤销此项授权',exact:true})).toHaveJSProperty('disabled',false)
 await testInfo.attach(`revocation-only-${width}`,{body:await page.screenshot({fullPage:true}),contentType:'image/png'})
 await choice.selectOption('revoke');await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect.poll(()=>f.posts.length).toBe(1);expect(f.posts[0].choices).toHaveLength(1)
 expect(f.posts[0].choices[0]).toMatchObject({domain:'business',decision:'revoke',expectedGrant:{revision:3}})
 await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。',{exact:true})).toBeVisible()
 await expect.poll(()=>f.state.clients[0].grants[0].revoked_at).not.toBeNull()
 expect(f.initializations).toEqual([])
})

test('controlled consumer screen permits business v7 only and sends exactly one scope',async({page},testInfo)=>{
 const f=await fixture(page)
 for(const d of f.state.descriptors)d.canApprove=d.domain==='business'
 await page.goto(entry);await page.getByLabel('选择已连接客户端').selectOption(clientId)
 for(const d of f.state.descriptors){
  const option=page.getByLabel(`本次选择：${d.domain==='planning'?'时间偏好':d.consent.title}`).getByRole('option',{name:'明确授权此项',exact:true})
  await expect(option).toHaveJSProperty('disabled',d.domain!=='business')
 }
 await page.getByLabel('本次选择：独立准备、手动行动与投递组').selectOption('approve')
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
  await testInfo.attach(`controlled-v7-only-${width}`,{body:await page.screenshot({fullPage:true}),contentType:'image/png'})
 }
 await page.getByLabel('我已核对账号、客户端及上方列出的本次变更。').check();await page.getByRole('button',{name:'确认所选变更'}).click()
 await expect(page.getByText('这次决定已记录；下方展示重新读取的当前授权状态。')).toBeVisible()
 expect(f.posts[0].choices).toHaveLength(1);expect(f.posts[0].choices[0]).toMatchObject({domain:'business',consentVersion:7})
})
