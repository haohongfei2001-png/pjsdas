import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
const aad=Buffer.from('todayaction-private-logical-backup-v1')
export function sealBackup(payload,key) {
 assert.equal(key.length,32)
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce)
 cipher.setAAD(aad)
 const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()])
 return Buffer.concat([aad,nonce,cipher.getAuthTag(),ciphertext])
}
export function openBackup(archive,key) {
 assert.equal(key.length,32);assert.ok(archive.length>aad.length+28)
 assert.deepEqual(archive.subarray(0,aad.length),aad)
 const decipher=createDecipheriv('aes-256-gcm',key,archive.subarray(aad.length,aad.length+12))
 decipher.setAAD(aad);decipher.setAuthTag(archive.subarray(aad.length+12,aad.length+28))
 return Buffer.concat([decipher.update(archive.subarray(aad.length+28)),decipher.final()])
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
