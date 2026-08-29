import test from 'node:test'; import assert from 'node:assert/strict';
import { ServerHost } from '@tablecore/server'; import { gridDuel } from '@tablecore/game-grid-duel';
import { createProtocolServer, PROTOCOL_VERSION, createTokenAuth } from '@tablecore/protocol';
import { buildStructuredMetrics } from '@tablecore/observability';
import { createWsServer, createWsClient } from '../src/index.js';
const wait = async (fn, ms=1000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');};
test('real websocket E2E: two players, spectator, update broadcast and reconnect sync', async()=>{
 const host=new ServerHost();host.createMatch({id:'m',game:gridDuel,players:['A','B'],spectatorPolicy:'public'});host.startMatch({matchId:'m',actor:'A'});
 const protocol=createProtocolServer(host); const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'}),tv:auth.issueToken({role:'spectator'})}; const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})}); const port=await ws.listen();
 const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A,playerId:'B'}}); const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B,playerId:'A'}}); const tv=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.tv,playerId:'A'}});
 await wait(()=>a.messages.some(m=>m.type==='WELCOME')&&b.messages.some(m=>m.type==='WELCOME')&&tv.messages.some(m=>m.type==='WELCOME'));
 for(const c of [a,b,tv]) c.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'});
 await wait(()=>[a,b,tv].every(c=>c.messages.some(m=>m.type==='SYNC')));
 const v=host.getSnapshot('m').snapshot.version; a.send({type:'ACTION',protocolVersion:1,matchId:'m',expectedVersion:v,action:{type:'MOVE',direction:'E'}});
 await wait(()=>[a,b,tv].every(c=>c.messages.some(m=>m.type==='UPDATE')));
 assert.equal(host.getSnapshot('m').snapshot.version,v+1);
 b.close(); await new Promise(r=>setTimeout(r,20));
 const b2=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B,playerId:'A'}}); await wait(()=>b2.messages.some(m=>m.type==='WELCOME')); b2.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m'}); await wait(()=>b2.messages.some(m=>m.type==='SYNC'));
 const sync=b2.messages.find(m=>m.type==='SYNC'); assert.equal(sync.snapshot.version,host.getSnapshot('m').snapshot.version);
 for(const c of [a,tv,b2])c.close(); await ws.close();
});

test('websocket UPDATE is scoped to subscribed match', async()=>{
 const host=new ServerHost();host.createMatch({id:'m1',game:gridDuel,players:['A','B']});host.createMatch({id:'m2',game:gridDuel,players:['C','D']});host.startMatch({matchId:'m1',actor:'A'});host.startMatch({matchId:'m2',actor:'C'});
 const protocol=createProtocolServer(host); const auth=createTokenAuth({secret:'01234567890123456789012345678901'}); const tokens={A:auth.issueToken({playerId:'A'}),B:auth.issueToken({playerId:'B'}),C:auth.issueToken({playerId:'C'})}; const ws=createWsServer({protocol,auth,resolveConnection:({claims})=>({role:claims.role,playerId:claims.playerId})}); const port=await ws.listen();
 const a=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.A}}); const b=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.B}}); const c=await createWsClient({port,hello:{type:'HELLO',protocolVersion:1,token:tokens.C}});
 for(const x of [a,b])x.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m1'}); c.send({type:'SYNC_REQUEST',protocolVersion:1,matchId:'m2'});
 await wait(()=>[a,b,c].every(x=>x.messages.some(m=>m.type==='SYNC')));
 const v=host.getSnapshot('m1').snapshot.version; a.send({type:'ACTION',protocolVersion:1,matchId:'m1',expectedVersion:v,action:{type:'MOVE',direction:'E'}});
 await wait(()=>b.messages.some(m=>m.type==='UPDATE'));
 await new Promise(r=>setTimeout(r,50)); assert.equal(c.messages.some(m=>m.type==='UPDATE'),false);
 for(const x of [a,b,c])x.close(); await ws.close();
});

// P2-OPS end-to-end: a real ServerHost's game metrics combined with a
// real createWsServer's network metrics via buildStructuredMetrics(),
// after actually driving traffic through both -- not two isolated unit
// tests asserting the pieces exist in theory.
test('buildStructuredMetrics combines real ServerHost + real transport metrics into the four categories after real traffic', async () => {
  const host = new ServerHost();
  host.createMatch({ id:'m', game:gridDuel, players:['A','B'] });
  host.startMatch({ matchId:'m', actor:'A' });
  const protocol = createProtocolServer(host);
  const auth = createTokenAuth({ secret:'01234567890123456789012345678901' });
  const startedAt = Date.now();
  const ws = createWsServer({ protocol, auth, resolveConnection: ({claims}) => ({role:claims.role, playerId:claims.playerId}) });
  const port = await ws.listen();

  const client = await createWsClient({ port, hello:{ type:'HELLO', protocolVersion:1, token: auth.issueToken({playerId:'A'}) } });
  client.send({ type:'SYNC_REQUEST', protocolVersion:1, matchId:'m' });
  await new Promise(r => setTimeout(r, 50));
  const v = host.getSnapshot('m').snapshot.version;
  client.send({ type:'ACTION', protocolVersion:1, matchId:'m', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  await new Promise(r => setTimeout(r, 50));

  const structured = buildStructuredMetrics({ server:{}, game: host.getMetrics(), network: ws.metrics.snapshot(), startedAt });

  assert.equal(structured.game.matchesCreated, 1);
  assert.equal(structured.game.matchesStarted, 1);
  assert.equal(structured.game.activeMatches, 1);
  assert.equal(structured.game.actionsAccepted, 1);
  assert.ok(structured.network.connectionsOpened >= 1);
  assert.ok(structured.network.messagesReceived >= 2, 'SYNC_REQUEST + ACTION were both real messages over a real socket');
  assert.ok(structured.network.bytesSent > 0);
  assert.ok(structured.server.uptimeSeconds >= 0);
  assert.equal(typeof structured.resource.memory.heapUsed, 'number');

  client.close();
  await ws.close();
});
