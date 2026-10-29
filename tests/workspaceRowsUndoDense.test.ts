import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {describe,expect,it} from 'vitest'

describe('conservative Undo dense-slot source boundary',()=>{
 it.each([
  ['workspace-rows-opportunity-stage-a.sql','e6dbad808cbbece78a21c8801f7248f55f91264a0ac5398967eeba726d6ad3cd'],
  ['workspace-rows-staged-opportunity-prototype.sql','e0eda0c08ac17f3ef885d267e661fd617c389af85b7f83e712409152bee80447'],
 ])('retains every pre-dense byte outside the reviewed Undo addition: %s',(file,hash)=>{
  const source=readFileSync(new URL('./sql/candidates/'+file,import.meta.url),'utf8')
  const begin=source.indexOf('        -- Only the ordinary, identity-preserving integer-index subset uses')
  const fallback=source.indexOf('        expected_rows:=old_rows; expected_ids:=old_ids;',begin)
  const end=source.indexOf('        if expected_rows is distinct from new_rows',fallback)
  expect(begin).toBeGreaterThan(0);expect(fallback).toBeGreaterThan(begin);expect(end).toBeGreaterThan(fallback)
  const restored=(source.slice(0,begin)+source.slice(fallback,end).replace(/        end if;\n$/,'')+source.slice(end))
   .replace('\n dense_slots integer[]; dense_slot integer; dense_old_count integer;','')
  expect(createHash('sha256').update(restored).digest('hex')).toBe(hash)
 })
})
