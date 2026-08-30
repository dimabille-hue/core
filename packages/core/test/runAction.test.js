import test from 'node:test'; import assert from 'node:assert/strict';
import { runAction } from '../src/index.js'; import { gridDuel } from '@tablecore/game-grid-duel';
test('rejects action by inactive player without mutation',()=>{const s=gridDuel.createInitialState();const before=structuredClone(s);const r=runAction({game:gridDuel,state:s,action:{type:'MOVE',actor:'B',direction:'N'}});assert.equal(r.ok,false);assert.deepEqual(s,before);});
test('moves active player and emits events',()=>{const s=gridDuel.createInitialState();const r=runAction({game:gridDuel,state:s,action:{type:'MOVE',actor:'A',direction:'E'}});assert.equal(r.ok,true);assert.deepEqual(r.state.players.A.position,{x:1,y:0});assert.equal(r.events[0].type,'PLAYER_MOVED');});
