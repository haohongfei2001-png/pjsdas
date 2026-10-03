// No password, PostgreSQL startup packet, SQL, or server-side modification.
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { openFixedTunnel,DATABASE_HOST,CA_SHA256 } from './fixed-db-transport.mjs'
const ca=await readFile(new URL('./certs/supabase-prod-ca-2021.crt',import.meta.url))
assert.equal(createHash('sha256').update(ca).digest('hex'),CA_SHA256)
let tunnel,socket
try{
 tunnel=await openFixedTunnel();socket=net.createConnection({host:'127.0.0.1',port:tunnel.port});socket.setTimeout(10000,()=>socket.destroy(Error('TLS_TIMEOUT')))
 await once(socket,'connect');socket.write(Buffer.from([0,0,0,8,4,210,22,47]));const [reply]=await once(socket,'data');assert.equal(reply.toString(),'S')
 socket=tls.connect({socket,servername:DATABASE_HOST,ca,rejectUnauthorized:true,minVersion:'TLSv1.2'});await once(socket,'secureConnect');assert.equal(socket.authorized,true)
 console.log(JSON.stringify({target:DATABASE_HOST,port:5432,transport:'existing local proxy',caSha256:CA_SHA256,tls:socket.getProtocol(),certificateVerified:true,hostnameVerified:true,credentialsSent:false,sqlExecuted:false}))
}catch(e){console.error(JSON.stringify({certificateVerified:false,credentialsSent:false,sqlExecuted:false,code:e.code||'TLS_PREFLIGHT_FAILED'}));process.exitCode=1}
finally{socket?.destroy();await tunnel?.close()}
