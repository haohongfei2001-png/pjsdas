/** Frozen same-checkout source. No sibling checkout or network input required. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
export const root=resolve(fileURLToPath(new URL('.',import.meta.url)))
export const source=resolve(root,'../../..')
export const sourceImport=path=>import(pathToFileURL(join(source,path)).href)
export const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex')
export const lock={commit:process.env.TA_RECLAIM_SOURCE_SHA}
export function verifySource(){
 assert.match(lock.commit,/^[a-f0-9]{40}$/)
 assert.equal(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),lock.commit)
 assert.equal(execFileSync('git',['-C',source,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','No live-edit of running source')
}
