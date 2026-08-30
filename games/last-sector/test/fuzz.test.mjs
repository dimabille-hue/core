import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector } from '../src/game.js';
import { createSeededRng } from '@tablecore/core';

function invariant(state){
  const playerIds=Object.keys(state.playerMeta||{});
  assert.ok(playerIds.length>=2 && playerIds.length<=4);
  for(const u of state.units.values()){
    assert.ok(state.tiles.has(u.coord), `unit off board ${u.coord}`);
    assert.ok(u.fuel>=0, `negative fuel ${u.owner}`);
    assert.ok(u.moves>=0, `negative moves ${u.owner}`);
    assert.ok(u.hp<=u.maxHp, `hp overflow ${u.owner}`);
    assert.ok((u.cargo||[]).reduce((s,i)=>s+(Number(i?.slots)||0),0)<=u.cargoSlots, `cargo overflow ${u.owner}`);
  }
  for(const [id,score] of state.scores) assert.ok(Number.isFinite(score) && score>=0, `bad score ${id}`);
  for(const [id,life] of Object.entries(state.lives||{})) assert.ok(Number.isInteger(life)&&life>=0, `bad lives ${id}`);
}

test('Last Sector survives 250 deterministic random-action matches without invariant violations', () => {
  for(let gameNo=0; gameNo<250; gameNo++){
    const players=gameNo%3===0?['p1','p2','p3']:gameNo%5===0?['p1','p2','p3','p4']:['p1','p2'];
    const state=lastSector.createInitialState({players,seed:gameNo+100,gridWidth:9,gridHeight:9,playerCount:players.length});
    const rng=createSeededRng(gameNo+900);
    let current=players[0];
    for(let step=0;step<300 && state.phase==='playing';step++){
      const legal=lastSector.getLegalActions(state,current);
      let action;
      if(!legal.length){ break; }
      const types=legal.map(x=>x.type);
      const type=types[rng.int(0,types.length-1)];
      if(type==='MOVE'){
        const unit=[...state.units.values()].find(u=>u.owner===current && u.hp>0); if(!unit) break;
        const [uq,ur]=unit.coord.split(',').map(Number); const dirs=ur%2===0?[[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]]:[[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]]; const coords=dirs.map(([dq,dr])=>`${uq+dq},${ur+dr}`).filter(c=>state.tiles.has(c));
        const target=coords[rng.int(0,Math.max(0,coords.length-1))]; action={type,actor:current,to:target||'0,0'};
      } else if(type==='ATTACK'||type==='STEAL'){
        const targets=[...state.units.values()].filter(u=>u.owner!==current&&u.owner!=='tanker'&&u.hp>0).map(u=>u.owner); action={type,actor:current,target:targets[0]||'nobody'};
      } else { action={type,actor:current}; }
      const validation=lastSector.validateAction(state,action);
      if(validation===true){
        const result=lastSector.applyActionInPlace(state,action,{rng});
        assert.equal(result.accepted,true,`accepted action rejected game=${gameNo} step=${step} type=${type}`);
        invariant(state);
      }
      current=state.activePlayer;
      // Ensure no accepted action changes the identity set.
      assert.deepEqual(Object.keys(state.playerMeta||{}).sort(),players.slice().sort());
    }
    invariant(state);
  }
});

// Regression coverage gap found while independently verifying this pack:
// the fuzz test above re-implements its own inline action-selection logic
// rather than calling lastSectorPack.bots.random/.aggressive -- so it
// never actually exercised the real bot functions a bot-driven match
// would use, and completely missed the four real bugs found there (NaN
// coordinates from `.q`/`.r` access on a "q,r" string; {q,r} objects
// handed to a string-only `to` field; non-parity-aware neighbor offsets
// wrong on odd rows; ATTACK proposed while standing on a nebula tile
// that blocks it). This drives the actual exported bot functions through
// the real dispatchMatchAction/runAction pipeline (not validateAction
// called directly, and not a hand-rolled action generator) -- the same
// path a real host with bot-controlled seats would use.
import { lastSectorPack } from '../src/index.js';
import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';

test('lastSectorPack.bots.random/.aggressive never produce a dispatch-rejected action, across many seeds/player-counts/turns', () => {
  let totalSteps = 0, totalMoves = 0;
  for (const botType of ['random', 'aggressive']) {
    for (const players of [['A','B'], ['A','B','C'], ['A','B','C','D']]) {
      for (let seed = 0; seed < 12; seed++) {
        let match = createMatch({ id:`fuzz-${botType}-${players.length}-${seed}`, game:lastSectorPack.game, players, options:{ seed } });
        match = startMatch({ match, game:lastSectorPack.game }).match;
        const rng = createSeededRng(seed * 31 + 11);
        for (let i = 0; i < 100 && match.status === 'running'; i++) {
          const actor = match.state.activePlayer;
          const action = lastSectorPack.bots[botType](match.state, actor, { rng });
          const r = dispatchMatchAction({ match, game:lastSectorPack.game, action });
          totalSteps++;
          assert.equal(r.ok, true, `bot-proposed action must always be accepted by the real dispatch pipeline: ${botType}, players=${players.length}, seed=${seed}, step=${i}, action=${JSON.stringify(action)}, error=${JSON.stringify(r.error)}`);
          if (action.type === 'MOVE') totalMoves++;
          match = r.match;
        }
      }
    }
  }
  assert.ok(totalSteps > 1000, 'sanity: this test should exercise a meaningful number of steps');
  assert.ok(totalMoves > 0, 'sanity: MOVE actions should actually occur (would be 0 if the coordinate bugs regressed)');
});
