import { expect, test, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { validateSnapshot } from '../src/snapshot.js'
import { BACKEND, seedSession, workspace, cors, health } from './fixtures/todayWorkspace.js'

const before = process.env.TA_UI_REVIEW === 'before'
const phase = before ? 'before' : 'after'
const base = '/pjsdas/'
const widths = [360,390,430,768,1280,1440]
const directory = 'test-results/ta02-' + phase
const metrics: unknown[] = []
function fixture() {
  const value = workspace()
  value.data.opportunities[0]!.company = 'A公司 · 跨设备招聘与长期岗位进展研究团队'
  value.data.opportunities[0]!.role = 'Senior Product Research / 高级产品策略、设计与用户研究负责人'
  // Existing TSUI-02 standalone date-only fixture, with no foreign process references.
  value.data.scheduleNodes = [...(value.data.scheduleNodes ?? []), ...Array.from({length:2},(_,i)=>({
    id:'tsui-node-'+i,occurrenceId:'tsui-occurrence-'+i,version:1,
    kind:'interview' as const,state:'scheduled' as const,constraintKind:'employer_hard' as const,
    temporal:{shape:'date_only' as const,precision:'date' as const,timezone:'Asia/Shanghai',
      date:new Date(Date.UTC(2026,8,25+i)).toISOString().slice(0,10),resolutionBasis:'source_explicit' as const},
    evidenceRefs:[],sourceVersionRefs:[],relatedActionIds:[],relatedPrepIds:[],
    createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',
  }))]
  validateSnapshot(value)
  return value
}
async function server(page: Page, value = fixture(), options: { failed?: boolean; held?: Promise<void> } = {}) {
  const state = { failed: options.failed ?? false, reads: 0, writes: [] as string[] }
  await seedSession(page.context())
  await page.route(/https:\/\/[^/]+\.supabase\.co\//, route => route.abort())
  await page.route(BACKEND + '/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return cors(route, {}, 204)
    if (path === '/api/health') return cors(route, health())
    if (path !== '/api/workspace') return cors(route, { code:'NOT_FOUND' }, 404)
    const body = request.postDataJSON()
    if (body.action !== 'read') { state.writes.push(body.action); return cors(route,{code:'UNEXPECTED_WRITE'},409) }
    state.reads++
    if (options.held) await options.held
    return state.failed ? cors(route,{code:'TEMPORARY_UNAVAILABLE'},503) : cors(route,{
      workspaceId:'ws-a', revision:91, workspaceVersion:'txn:91', schemaVersion:value.version, snapshot:value,
    })
  })
  return state
}
async function matrix(page: Page, label: string) {
  await mkdir(directory,{recursive:true})
  for (const width of widths) for (const scale of [100,200]) {
    await page.setViewportSize({width,height:900})
    await page.evaluate(scale => { document.documentElement.style.fontSize = scale + '%' },scale)
    const report = await page.evaluate(() => {
      const issues: string[] = []
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) issues.push('horizontal overflow')
      const tell = document.querySelector<HTMLElement>('.tsui-tell-button')
      if (tell && tell.scrollWidth > tell.clientWidth + 1) issues.push('capture label overflow')
      const parse = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number)
      const lum = (rgb:number[]) => rgb.slice(0,3).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i]!,0)
      const ratios: {selector:string;ratio:number}[] = []
      for (const selector of ['.tsui-task-copy>span','.tsui-task-context','.tsui-mobile-switch button','.cloud-security-note','.ta-consent p','.ta-consent-primary','.tsui-library-heading span']) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          if (!element.getClientRects().length) continue
          const style = getComputedStyle(element)
          let parent: HTMLElement|null = element
          let bg = [255,255,255,1]
          while(parent) {
            const parsed = parse(getComputedStyle(parent).backgroundColor)
            if ((parsed[3] ?? 1) >= .99) { bg = parsed; break }
            parent = parent.parentElement
          }
          const fg = parse(style.color), f = lum(fg), b = lum(bg)
          const ratio = (Math.max(f,b)+.05)/(Math.min(f,b)+.05)
          ratios.push({selector,ratio})
          if (ratio < 4.5) issues.push('text contrast ' + selector + ': ' + ratio.toFixed(2))
        }
      }
      return {issues,ratios,rootFont:getComputedStyle(document.documentElement).fontSize,
        taskIds:[...document.querySelectorAll('[data-action-id]')].map(x=>x.getAttribute('data-action-id'))}
    })
    metrics.push({label,width,scale,...report})
    await writeFile(directory + '/metrics.json',JSON.stringify(metrics,null,2))
    await page.screenshot({path:directory+'/'+label+'-'+width+'-'+scale+'.png',fullPage:true,animations:'disabled'})
    if ((width === 390 && scale === 100 || width === 360 && scale === 200 || width === 1440 && scale === 100)) {
      const encoded=(await page.screenshot({type:'jpeg',quality:48,animations:'disabled'})).toString('base64')
      const key='TA02_'+phase.toUpperCase()+'_'+label+'_'+width+'_'+scale
      for(let i=0;i<encoded.length;i+=3000) console.log(key+'_DATA:'+encoded.slice(i,i+3000))
    }
    console.log('TA02_METRIC:'+JSON.stringify({phase,label,width,scale,...report}))
    if (!before) expect(report.issues, label+' '+width+' '+scale).toEqual([])
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize=''})
}
test.beforeEach(async ({page})=>{await page.clock.setFixedTime(new Date('2026-09-23T08:00:00.000Z'))})
test('TA-02 loaded surfaces retain identifiers, detail, capture and keyboard focus across the width/text matrix',async ({page})=>{
  test.setTimeout(180000)
  const state=await server(page)
  await page.goto(base+'today')
  await expect(page.locator('.tsui-task-row')).toHaveCount(2)
  const ids=await page.locator('[data-action-id]').evaluateAll(items=>items.map(x=>x.getAttribute('data-action-id')))
  await matrix(page,'TODAY')
  expect(await page.locator('[data-action-id]').evaluateAll(items=>items.map(x=>x.getAttribute('data-action-id')))).toEqual(ids)
  await page.goto(base+'library')
  await expect(page.locator('.tsui-job-open')).toHaveCount(2)
  await matrix(page,'LIBRARY')
  await page.goto(base+'library/A-opp-1')
  await expect(page.locator('.job-detail-page')).toBeVisible()
  await matrix(page,'JOB_DETAIL')
  await page.goto(base+'schedule')
  await expect(page.locator('.tsui-schedule-panel')).toBeVisible()
  await page.locator('.tsui-schedule-tabs button').first().click()
  await matrix(page,'SCHEDULE')
  await page.locator('.tsui-schedule-row').first().click()
  await expect(page.locator('.tsui-schedule-detail')).toBeVisible()
  await matrix(page,'EVENT_DETAIL')
  await page.goto(base+'today')
  await page.locator('.tsui-tell-button').click()
  const dialog=page.getByRole('dialog',{name:'告诉 TodayAction'})
  await expect(dialog.getByRole('textbox',{name:'要告诉 TodayAction 的内容'})).toBeFocused()
  await matrix(page,'CAPTURE')
  await page.keyboard.press('Escape')
  await expect(page.locator('.tsui-tell-button')).toBeFocused()
  if (!before) {
    const outline=await page.locator('.tsui-tell-button').evaluate(x=>({width:getComputedStyle(x).outlineWidth,style:getComputedStyle(x).outlineStyle}))
    expect(outline.style).toBe('solid')
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3)
  }
  await page.goto(base+'settings')
  await expect(page.locator('.cloud-settings-card')).toBeVisible()
  await matrix(page,'SETTINGS')
  expect(state.writes).toEqual([])
})
test('TA-02 first use and signed-in empty workspace are distinct and truthful',async ({page,browser})=>{
  test.setTimeout(90000)
  await page.route(/https:\/\/[^/]+\.supabase\.co\//,route=>route.abort())
  await page.goto(base+'today')
  await expect(page.getByText('先让 TodayAction 了解你的求职进展')).toBeVisible()
  await matrix(page,'FIRST_USE')
  const context=await browser.newContext()
  const emptyPage=await context.newPage()
  await emptyPage.clock.setFixedTime(new Date('2026-09-23T08:00:00.000Z'))
  const empty=workspace()
  for(const key of Object.keys(empty.data)) if(Array.isArray((empty.data as any)[key])) (empty.data as any)[key]=[]
  const state=await server(emptyPage,empty)
  await emptyPage.goto(base+'today')
  if (!before) await expect(emptyPage.getByText('账号工作区已读取，目前没有今日任务')).toBeVisible()
  else await expect(emptyPage.getByText('先让 TodayAction 了解你的求职进展')).toBeVisible()
  await expect(emptyPage.locator('.tsui-task-row')).toHaveCount(0)
  await matrix(emptyPage,'EMPTY_ACCOUNT')
  expect(state.writes).toEqual([])
  await context.close()
})
test('TA-02 loading and read failure stay separate from an empty workspace',async ({page,browser})=>{
  test.setTimeout(90000)
  let release=()=>{}
  const held=new Promise<void>(resolve=>{release=resolve})
  const state=await server(page,fixture(),{held})
  await page.goto(base+'today')
  await expect(page.getByText('正在确认最新状态…')).toBeVisible()
  await expect(page.locator('.tsui-task-row')).toHaveCount(0)
  await matrix(page,'LOADING')
  release()
  await expect(page.locator('.tsui-task-row')).toHaveCount(2)
  const context=await browser.newContext(),errorPage=await context.newPage()
  await errorPage.clock.setFixedTime(new Date('2026-09-23T08:00:00.000Z'))
  const failure=await server(errorPage,fixture(),{failed:true})
  await errorPage.goto(base+'today')
  await expect(errorPage.getByText('暂时无法确认今天，请重试。')).toBeVisible()
  await matrix(errorPage,'READ_ERROR')
  expect(state.writes).toEqual([])
  expect(failure.writes).toEqual([])
  await context.close()
})
test('TA-02 verified cache and self-owned authorization keep source failures visible',async ({page})=>{
  test.setTimeout(90000)
  const state=await server(page)
  await page.goto(base+'today')
  await expect(page.locator('.tsui-task-row')).toHaveCount(2)
  state.failed=true
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('使用已验证缓存，暂时无法刷新。')).toBeVisible()
  await matrix(page,'CACHED')
  await page.goto(base+'?authorization_id=synthetic-ui-review')
  await expect(page.getByRole('heading',{name:'授权 ChatGPT 访问 TodayAction'})).toBeVisible()
  await matrix(page,'AUTHORIZATION')
  expect(state.writes).toEqual([])
})
