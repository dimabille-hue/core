import test from 'node:test'; import assert from 'node:assert/strict'; import { gridDuel } from '../src/index.js';
test('initial state is valid',()=>{const s=gridDuel.createInitialState();assert.equal(s.activePlayer,'A');assert.equal(s.players.A.hp,3);});
test('same input produces same result',()=>{const s=gridDuel.createInitialState();const a={type:'MOVE',actor:'A',direction:'E'};assert.deepEqual(gridDuel.applyAction(s,a),gridDuel.applyAction(s,a));});
test('out of bounds is rejected by game without state mutation',()=>{const s=gridDuel.createInitialState();const before=structuredClone(s);const r=gridDuel.applyAction(s,{type:'MOVE',actor:'A',direction:'N'});assert.equal(r.events[0].code,'OUT_OF_BOUNDS');assert.deepEqual(s,before);});
