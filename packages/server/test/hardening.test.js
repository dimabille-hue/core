import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerHost } from '../src/index.js';
import { createMatch } from '@tablecore/core';
import { gridDuel } from '@tablecore/game-grid-duel';
import { sectorExpedition } from '@tablecore/game-sector-expedition';

test('public snapshots never disclose the server RNG seed',()=>{
  const h=new ServerHost(); h.createMatch({id:'m',game:gridDuel,players:['A','B'],options:{seed:12345}}); h.startMatch({matchId:'m',actor:'A'});
  const s=h.getSnapshot('m').snapshot; assert.equal('seed' in s,false); assert.equal('rngState' in s,false);
});

// Regression test: the previous version of this test checked `'seed' in s`
// where `s` is the top-level snapshot wrapper ({id,status,players,state,
// result,version}) -- `seed` was never a field of THAT object, only of
// `s.state` (sector-expedition stored it there). The check was trivially
// true regardless of whether the seed actually leaked through `state`,
// which it did (see the games/sector-expedition/test regression test for
// the confirmed leak and fix). Checking the right nesting level here too.
test('player snapshot state does not expose the seed at the correct nesting level, not just the wrapper',()=>{
  const h=new ServerHost(); h.createMatch({id:'m',game:sectorExpedition,players:['A','B'],options:{seed:12345}}); h.startMatch({matchId:'m',actor:'A'});
  const s=h.getSnapshot('m','A').snapshot;
  assert.equal('seed' in s,false); assert.equal('rngState' in s,false);
  assert.equal('seed' in (s.state ?? {}), false, 'the seed must not be present on state either, not just on the outer snapshot wrapper');
});

// Regression test: getSnapshot()'s viewer-keyed cache used a bare
// '__spectator__' sentinel string for the anonymous-viewer cache slot.
// createMatch() does not reject that specific string (it is a
// syntactically valid player id), so nothing prevented a player from
// literally being named '__spectator__' -- and when that happened, that
// player's own, correctly-scoped snapshot got cached under the exact same
// key a real anonymous spectator's request would look up next, leaking
// that player's private data to a real spectator at the same version.
//
// sector-expedition's own getPlayerView() happens to make spectators
// fully omniscient by design (a deliberate TV/broadcast capability, see
// its manifest's 'tv' capability) -- so it can't demonstrate this
// specific collision, since spectators and the '__spectator__'-named
// player would see the same (full) data either way. A minimal synthetic
// game with an explicit, real distinction between player-private and
// spectator-visible data is used instead, matching the pattern used
// elsewhere in this suite for isolating a specific engine behavior from
// any one game's own design choices.
test('a player literally named __spectator__ cannot poison the anonymous-spectator snapshot cache slot',()=>{
  const privacyGame = {
    createInitialState(){ return { phase:'playing', players:{ '__spectator__':{ id:'__spectator__', secret:'PLAYER-SECRET' }, B:{ id:'B', secret:'OTHER-SECRET' } } }; },
    getGameStatus(){ return { finished:false }; },
    getLegalActions(){ return []; },
    getPlayerView(state, viewer){
      const s=structuredClone(state);
      for (const id of Object.keys(s.players)) if (id!==viewer) delete s.players[id].secret; // never shown to anyone but the owner; spectators (viewer=null) see nothing private
      return s;
    },
  };
  const h=new ServerHost();
  h.createMatch({id:'m',game:privacyGame,players:['__spectator__','B']});
  h.startMatch({matchId:'m',actor:'__spectator__'});
  // The player named '__spectator__' requests their own snapshot first,
  // populating whatever cache slot their viewer key maps to.
  const ownView = h.getSnapshot('m','__spectator__').snapshot.state;
  assert.equal(ownView.players['__spectator__'].secret, 'PLAYER-SECRET', 'sanity: the player can see their own secret');
  // A real anonymous spectator now requests a sync at the same version.
  const spectatorView = h.getSnapshot('m',null).snapshot.state;
  assert.equal(spectatorView.players['__spectator__'].secret, undefined,
    'a real spectator must never receive the __spectator__-named player\'s own cached snapshot');
});

// P2-OPS: Game-category match-lifecycle metrics on ServerHost. Before
// this, none of this was tracked at all -- no way to answer "how many
// matches has this process handled" without instrumenting call sites
// externally.
test('ServerHost tracks match-lifecycle metrics: created, started, finished, active gauge, actions accepted/rejected', () => {
  const h = new ServerHost();
  const initial = h.getMetrics();
  assert.equal(initial.matchesCreated, 0);
  assert.equal(initial.activeMatches, 0);

  h.createMatch({ id:'m1', game:gridDuel, players:['A','B'] });
  h.createMatch({ id:'m2', game:gridDuel, players:['C','D'] });
  assert.equal(h.getMetrics().matchesCreated, 2);
  assert.equal(h.getMetrics().activeMatches, 2, 'activeMatches is a live gauge, not incrementally tracked, and must reflect both matches immediately');

  h.startMatch({ matchId:'m1', actor:'A' });
  assert.equal(h.getMetrics().matchesStarted, 1);

  const v = h.getSnapshot('m1').snapshot.version;
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'A', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsAccepted, 1);

  // A rejected action (stale version) must count as rejected, not silently ignored.
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'A', expectedVersion:999, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsRejected, 1);

  // Actor spoofing and non-participant attempts count as rejected too.
  h.submitAction({ matchId:'m1', connectionPlayerId:'A', actor:'B', expectedVersion:v, action:{type:'MOVE',direction:'E'} });
  assert.equal(h.getMetrics().actionsRejected, 2);
});

test('ServerHost getMetrics() counts a match transitioning to finished exactly once, not once per subsequent action', () => {
  const oneShotFinishGame = {
    createInitialState: () => ({ activePlayer:'A', phase:'playing', winner:null, players:{A:{id:'A'},B:{id:'B'}} }),
    getLegalActions: (state, actor) => actor===state.activePlayer ? [{type:'END'}] : [],
    getGameStatus: (state) => ({ finished: state.phase==='finished', winner: state.winner }),
    applyActionInPlace(state, action) {
      state.phase='finished'; state.winner=action.actor;
      return { state, events:[{type:'GAME_FINISHED',winner:action.actor}] };
    },
  };
  const h = new ServerHost();
  h.createMatch({ id:'m', game:oneShotFinishGame, players:['A','B'] });
  h.startMatch({ matchId:'m', actor:'A' });
  const v = h.getSnapshot('m','A').snapshot.version;
  const r = h.submitAction({ matchId:'m', connectionPlayerId:'A', actor:'A', expectedVersion:v, action:{type:'END'} });
  assert.equal(r.ok, true);
  assert.equal(h.getMetrics().matchesFinished, 1);
  // A second action attempt against the now-finished match must be
  // rejected by dispatchMatchAction's own MATCH_NOT_RUNNING guard, and
  // must NOT double-count matchesFinished.
  const r2 = h.submitAction({ matchId:'m', connectionPlayerId:'B', actor:'B', expectedVersion:h.getSnapshot('m').snapshot.version, action:{type:'END'} });
  assert.equal(r2.ok, false);
  assert.equal(h.getMetrics().matchesFinished, 1, 'matchesFinished must not increment again for an action rejected against an already-finished match');
});
