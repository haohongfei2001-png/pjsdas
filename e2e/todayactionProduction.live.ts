import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolveReleaseMetadata } from '../scripts/release-metadata.mjs'

const targets = [
  {name:'CANONICAL',base:'https://todayaction.com/',legacy:false},
  {name:'HISTORICAL',base:'https://haohongfei2001-png.github.io/pjsdas/',legacy:true},
]
const expected = process.env.TA_EXPECTED_COMMIT
const metadata = resolveReleaseMetadata()
const pinned = JSON.parse(await readFile('public/brand/ASSET_MANIFEST.json','utf8'))
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const reports: unknown[]=[]
test.use({serviceWorkers:'block'})
for (const target of targets) {
  test(target.name + ' exact anonymous release, actual asset bytes, fallback, DOM titles and local images',async ({page,request})=>{
    test.setTimeout(90000)
    expect(expected).toMatch(/^[0-9a-f]{40}$/)
    const frontend=await request.get(target.base+'release-manifest.json')
    expect(frontend.status()).toBe(200)
    const release=await frontend.json()
    expect(release.commitSha).toBe(expected)
    expect(release.frontendArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(release.mcpContractHash).toBe(metadata.mcpContractHash)
    expect(release.migrationSetHash).toBe(metadata.migrationSetHash)
    const health=await request.get('https://todayaction.com/api/health')
    expect(health.status()).toBe(200)
    const healthBody=await health.json()
    const backend=healthBody.release
    expect(backend.commitSha).toBe(expected)
    expect(backend.mcpContractHash).toBe(metadata.mcpContractHash)
    expect(backend.migrationSetHash).toBe(metadata.migrationSetHash)
    const assetIndex=await request.get(target.base+'brand/ASSET_MANIFEST.json')
    expect(assetIndex.status()).toBe(200)
    expect(assetIndex.headers()['content-type']).toMatch(/json/)
    expect(await assetIndex.json()).toEqual(pinned)
    const assets:{path:string;sha256:string;bytes:number;mime:string}[]=[]
    for(const [path,item] of Object.entries(pinned.assets) as [string,{sha256:string;bytes:number}][]) {
      const url=target.base+path.replace(/^public\//,'')
      const response=await request.get(url)
      expect(response.status(),url).toBe(200)
      expect(new URL(response.url()).origin,url).toBe(new URL(target.base).origin)
      const bytes=await response.body(),mime=response.headers()['content-type']??''
      expect(bytes.length,url).toBe(item.bytes)
      expect(digest(bytes),url).toBe(item.sha256)
      expect(bytes.subarray(0,100).toString().toLowerCase(),url).not.toContain('<!doctype html')
      if(path.endsWith('.png')) {
        expect(mime,url).toMatch(/^image\/png/)
        expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
      } else if(path.endsWith('.svg')) expect(mime,url).toMatch(/^image\/svg\+xml/)
      else if(path.endsWith('.ico')) {
        expect(mime,url).toMatch(/^image\//)
        expect(bytes.readUInt16LE(2)).toBe(1)
        expect(bytes.readUInt16LE(4)).toBe(3)
      }
      assets.push({path,sha256:digest(bytes),bytes:bytes.length,mime})
    }
    const manifestResponse=await request.get(target.base+'manifest.webmanifest')
    expect(manifestResponse.status()).toBe(200)
    expect(manifestResponse.headers()['content-type']).toMatch(/json|manifest/)
    const manifest=await manifestResponse.json()
    expect(manifest.name).toBe('TodayAction')
    expect(manifest.short_name).toBe('TodayAction')
    expect(manifest.id).toBe('/')
    expect(new URL(manifest.start_url,manifestResponse.url()).href).toBe(target.base+'today')
    expect(new URL(manifest.scope,manifestResponse.url()).href).toBe(target.base)
    const forbidden:string[]=[],imageErrors:string[]=[],cspErrors:string[]=[]
    await page.route('**/*',route=>{
      const r=route.request(),url=new URL(r.url())
      if(!['GET','HEAD','OPTIONS'].includes(r.method())) {forbidden.push(r.method()+' '+url.pathname);return route.abort()}
      if(url.hostname.endsWith('.supabase.co'))return route.abort()
      return route.continue()
    })
    page.on('requestfailed',r=>{if(r.resourceType()==='image')imageErrors.push(r.url())})
    page.on('console',m=>{if(m.type()==='error' && /content security policy|refused to load.*image/i.test(m.text()))cspErrors.push(m.text())})
    const routeReports:unknown[]=[]
    for(const [path,title] of [
      ['','今天 · TodayAction'],['today','今天 · TodayAction'],['library','岗位库 · TodayAction'],
      ['library/brand-readback-nonexistent','岗位库 · TodayAction'],
      ['schedule','日程 · TodayAction'],['settings','设置 · TodayAction'],
      ['decisions','待确认 · TodayAction'],['history','历史 · TodayAction'],
      ['today/capture','记录进展 · TodayAction'],
      ['unmatched-brand-readback','今天 · TodayAction'],
    ]) {
      const response=await request.get(target.base+path)
      // GitHub Pages serves the committed SPA 404 body, retaining HTTP 404.
      expect((target.legacy && path!=='') || path==='unmatched-brand-readback' ? [200,404] : [200],path).toContain(response.status())
      const html=await response.text()
      console.log('TA_PRODUCTION_ROUTE:'+JSON.stringify({target:target.name,path,status:response.status(),initialTitle:html.match(/<title>(.*?)<\/title>/)?.[1]??null,csp:response.headers()['content-security-policy']??null}))
      expect(html,path).toContain('<title>TodayAction</title>')
      expect(html,path).toContain('name="application-name" content="TodayAction"')
      expect(html,path).toContain('name="apple-mobile-web-app-title" content="TodayAction"')
      expect(html,path).toContain('name="theme-color" content="#F5F6F9"')
      const prefix=new URL(target.base).pathname
      for(const resource of ['brand/favicon.svg?v=ta-a-1','brand/favicon-32.png?v=ta-a-1','brand/favicon.ico?v=ta-a-1','brand/apple-touch-icon.png?v=ta-a-1','manifest.webmanifest']) {
        expect(html,path).toContain('href="'+prefix+resource+'"')
      }
      await page.goto(target.base+path)
      await expect(page).toHaveTitle(title)
      await expect(page.locator('body')).not.toContainText('PJSDAS')
      await expect(page.locator('.tsui-brand')).toHaveAccessibleName('TodayAction，今天')
      const decoded=await page.locator('.tsui-brand img').evaluate(async (x)=>{
        const image=x as HTMLImageElement;await image.decode()
        return {width:image.naturalWidth,height:image.naturalHeight,url:image.currentSrc}
      })
      expect(decoded.width).toBeGreaterThan(0)
      expect(new URL(decoded.url).pathname).toBe(prefix+'brand/a-mark-primary.svg')
      await page.locator('link[rel="icon"],link[rel="apple-touch-icon"]').evaluateAll(async links=>{
        await Promise.all(links.map(async link=>{const image=new Image();image.src=(link as HTMLLinkElement).href;await image.decode()}))
      })
      await page.reload()
      await expect(page).toHaveTitle(title)
      routeReports.push({path,status:response.status(),title:await page.title(),brandImage:decoded,csp:response.headers()['content-security-policy']??null})
    }
    for(const icon of [...manifest.icons,{src:'brand/apple-touch-icon.png',sizes:'180x180'}]) {
      const url=new URL(icon.src,manifestResponse.url()).href
      const response=await request.get(url),bytes=await response.body()
      const size=bytes.readUInt32BE(16)+'x'+bytes.readUInt32BE(20)
      expect(size).toBe(icon.sizes)
      const decoded=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();return image.naturalWidth+'x'+image.naturalHeight},url)
      expect(decoded).toBe(icon.sizes)
    }
    expect(forbidden).toEqual([])
    expect(imageErrors).toEqual([])
    expect(cspErrors).toEqual([])
    await page.goto(target.base+'today')
    await page.setViewportSize({width:390,height:844})
    await mkdir('test-results/todayaction-production',{recursive:true})
    await page.screenshot({path:'test-results/todayaction-production/'+target.name+'.png',fullPage:true})
    const encoded=(await page.screenshot({type:'jpeg',quality:55})).toString('base64')
    for(let i=0;i<encoded.length;i+=3000)console.log('TA_PRODUCTION_'+target.name+'_DATA:'+encoded.slice(i,i+3000))
    const report={target:target.name,base:target.base,expected,frontend:release,backendCommit:backend.commitSha,assets,routes:routeReports,manifest,forbidden,imageErrors,cspErrors,
      devices:'DEFERRED',thirdPartyBrand:'DEFERRED',privateWorkspace:'DEFERRED',legal:'DEFERRED'}
    reports.push(report)
    await writeFile('test-results/todayaction-production/readback.json',JSON.stringify(reports,null,2))
    console.log('TA_PRODUCTION_READBACK:'+JSON.stringify(report))
  })
}
