// Fixed destination only. TLS still terminates at Supabase, never at this tunnel.
import net from 'node:net'
import { once } from 'node:events'
export const DATABASE_HOST='db.yyrzwpoxlxpafdlbkdtg.supabase.co'
export const CA_SHA256='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7'
async function read(socket,n){
 while(true){const b=socket.read(n);if(b)return b;if(socket.destroyed)throw Error('PROXY_CLOSED');await once(socket,'readable')}
}
export async function openFixedTunnel(){
 const sockets=new Set()
 const server=net.createServer(async local=>{
  const remote=net.createConnection({host:'127.0.0.1',port:7895});sockets.add(local);sockets.add(remote)
  const finish=()=>{local.destroy();remote.destroy();sockets.delete(local);sockets.delete(remote)}
  local.on('error',finish);remote.on('error',finish);local.on('close',finish);remote.on('close',finish)
  remote.setTimeout(5000,()=>remote.destroy(Error('PROXY_TIMEOUT')))
  try{
   await once(remote,'connect');remote.write(Buffer.from([5,1,0]))
   const hello=await read(remote,2);if(!hello.equals(Buffer.from([5,0])))throw Error('PROXY_AUTH_UNSUPPORTED')
   const host=Buffer.from(DATABASE_HOST),port=Buffer.alloc(2);port.writeUInt16BE(5432)
   remote.write(Buffer.concat([Buffer.from([5,1,0,3,host.length]),host,port]))
   const reply=await read(remote,4);if(reply[0]!==5||reply[1]!==0||reply[2]!==0)throw Error('PROXY_ROUTE_FAILED')
   const size=reply[3]===1?4:reply[3]===4?16:reply[3]===3?(await read(remote,1))[0]:0
   if(!size)throw Error('PROXY_PROTOCOL_FAILED');await read(remote,size+2)
   remote.setTimeout(0);local.pipe(remote);remote.pipe(local)
  }catch{finish()}
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 return {port:server.address().port,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r))}}
}
