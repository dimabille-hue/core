import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorExpeditionPack, sectorExpedition } from '../src/index.js';
import { createGamePack } from '@tablecore/game-pack';
import { createSeededRng } from '@tablecore/core';
import { runAction } from '@tablecore/core';
import { ServerHost } from '@tablecore/server';
import { createProtocolServer } from '@tablecore/protocol';

test('sector expedition pack is valid and data-driven',()=>{
  const pack=createGamePack(sectorExpeditionPack);
  assert.equal(pack.manifest.id,'sector-expedition');
  const state=pack.game.createInitialState({players:['A','B'],seed:123});
  assert.equal(Object.keys(state.map).length,19);
  assert.equal(state.map['0,0'].object,'station');
  assert.equal(state.map['1,0'].object,'salvage');
});

// Regression test: `state.seed` used to be stored on state and leaked to
// every viewer (including spectators) via getPlayerView(), which meant
// the RNG's entire internal state was trivially, deterministically
// re-derivable from a public field -- no brute force needed at all,
// regardless of how resistant the RNG algorithm itself is to state
// recovery from observed outputs (see packages/core/src/rng/SeededRng.js
// -- state is a public, deterministic function of the seed). Fixed by not
// storing it on state at all, not merely redacting it in projection.
test('seed is never present on authoritative state or on any viewer\'s snapshot, including spectators',()=>{
  const state=sectorExpedition.createInitialState({players:['A','B'],seed:0x12345678});
  assert.equal('seed' in state, false, 'authoritative state must not retain the seed at all');
  const host=new ServerHost();
  host.createMatch({id:'sector-seed',game:sectorExpedition,players:['A','B'],options:{seed:0x12345678}});
  host.startMatch({matchId:'sector-seed',actor:'A'});
  const forA=host.getSnapshot('sector-seed','A').snapshot.state;
  const forB=host.getSnapshot('sector-seed','B').snapshot.state;
  const forSpectator=host.getSnapshot('sector-seed',null).snapshot.state;
  assert.equal('seed' in forA, false);
  assert.equal('seed' in forB, false);
  assert.equal('seed' in forSpectator, false);
});

test('MOVE validates payload and does not mutate on bad target',()=>{
  const state=sectorExpedition.createInitialState({players:['A','B']});
  const before=structuredClone(state);
  const r=runAction({game:sectorExpedition,state,action:{type:'MOVE',actor:'A',target:{q:9,r:9}}});
  assert.equal(r.ok,false); assert.equal(r.error.code,'OUT_OF_MAP'); assert.deepEqual(state,before);
});

test('movement opens only the moved hex and consumes fuel',()=>{
  const state=sectorExpedition.createInitialState({players:['A','B']});
  const r=runAction({game:sectorExpedition,state,action:{type:'MOVE',actor:'A',target:{q:1,r:0}},context:{rng:createSeededRng(5)}});
  assert.equal(r.ok,true);
  assert.equal(r.state.players.A.position.q,1);
  assert.equal(r.state.players.A.fuel,3);
  assert.ok(r.state.map['1,0'].revealedBy.includes('A'));
});

test('scan reveals a bounded set from station and is deterministic with a seed',()=>{
  const a=sectorExpedition.createInitialState({players:['A','B']});
  const b=structuredClone(a);
  const ra=runAction({game:sectorExpedition,state:a,action:{type:'SCAN',actor:'A'},context:{rng:createSeededRng(77)}});
  const rb=runAction({game:sectorExpedition,state:b,action:{type:'SCAN',actor:'A'},context:{rng:createSeededRng(77)}});
  assert.deepEqual(ra.state,rb.state); assert.deepEqual(ra.events,rb.events);
  assert.equal(ra.state.map['0,0'].revealedBy.includes('A'),true);
});

test('random event is part of authoritative simulation, not UI',()=>{
  const state=sectorExpedition.createInitialState({players:['A','B']});
  const r=runAction({game:sectorExpedition,state,action:{type:'MOVE',actor:'A',target:{q:1,r:0}},context:{rng:createSeededRng(1)}});
  assert.ok(r.events.some(e=>e.type==='RANDOM_EVENT') || r.events.some(e=>e.type==='SALVAGE_COLLECTED')===false);
});

test('player view hides undiscovered map tiles and remote private data',()=>{
  const state=sectorExpedition.createInitialState({players:['A','B']});
  state.players.B.position={q:1,r:-1};
  const view=sectorExpedition.getPlayerView(state,'A');
  assert.equal(view.map['2,-1'].object,null);
  assert.equal(view.map['2,-1'].terrain,'unknown');
  assert.equal(view.players.B.position,null);
  assert.equal(view.players.B.hull,3);
});

test('server snapshot can be projected per player',()=>{
  const host=new ServerHost();
  host.createMatch({id:'sector',game:sectorExpedition,players:['A','B'],options:{seed:99}});
  host.startMatch({matchId:'sector',actor:'A'});
  const a=host.getSnapshot('sector','A').snapshot;
  assert.equal(a.state.map['2,-1'].terrain,'unknown');
});

test('protocol preserves viewer projection for sync and updates',async ()=>{
  const host=new ServerHost();
  host.createMatch({id:'sector',game:sectorExpedition,players:['A','B'],options:{seed:99}});
  host.startMatch({matchId:'sector',actor:'A'});
  const protocol=createProtocolServer(host);
  const connection={role:'player',playerId:'A'};
  const sync=(await protocol.handle({connection,message:{type:'SYNC_REQUEST',protocolVersion:1,matchId:'sector'}}))[0];
  assert.equal(sync.type,'SYNC'); assert.equal(sync.snapshot.state.map['2,-1'].terrain,'unknown');
});
