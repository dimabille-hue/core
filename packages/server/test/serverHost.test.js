import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/index.js';
import { gridDuel } from '@tablecore/game-grid-duel';

function runningHost(){ const h=new ServerHost(); assert.equal(h.createMatch({id:'m1',game:gridDuel,players:['A','B']}).ok,true); assert.equal(h.startMatch({matchId:'m1',actor:'A'}).ok,true); return h; }

test('host owns match and returns snapshot',()=>{ const h=runningHost(); const s=h.getSnapshot('m1'); assert.equal(s.ok,true); assert.equal(s.snapshot.status,'running'); assert.equal(s.snapshot.version,1); });
test('non participant cannot start or act',()=>{ const h=runningHost(); assert.equal(h.submitAction({matchId:'m1',connectionPlayerId:'X',actor:'X',expectedVersion:1,action:{type:'MOVE',direction:'E'}}).error.code,'NOT_MATCH_PARTICIPANT'); });
test('actor spoofing is rejected',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'B',expectedVersion:1,action:{type:'MOVE',direction:'E'}}); assert.equal(r.error.code,'ACTOR_SPOOFING'); });
test('stale version is rejected without mutation',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'A',expectedVersion:0,action:{type:'MOVE',direction:'E'}}); assert.equal(r.error.code,'STALE_VERSION'); assert.equal(h.getSnapshot('m1').snapshot.version,1); });
test('valid action advances authoritative state and version',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'A',actor:'A',expectedVersion:1,action:{type:'MOVE',direction:'E'}}); assert.equal(r.ok,true); assert.equal(r.version,2); assert.equal(r.snapshot.state.players.A.position.x,1); assert.equal(r.events[0].type,'PLAYER_MOVED'); });
test('invalid turn does not mutate authoritative state',()=>{ const h=runningHost(); const r=h.submitAction({matchId:'m1',connectionPlayerId:'B',actor:'B',expectedVersion:1,action:{type:'MOVE',direction:'W'}}); assert.equal(r.error.code,'ILLEGAL_ACTION'); const s=h.getSnapshot('m1').snapshot; assert.equal(s.version,1); assert.deepEqual(s.state.players.B.position,{x:4,y:4}); });
test('unknown match is rejected',()=>{ const h=new ServerHost(); assert.equal(h.getSnapshot('missing').error.code,'MATCH_NOT_FOUND'); });
