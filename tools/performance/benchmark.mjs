import { sectorExpedition } from '../../games/sector-expedition/src/game.js';
import { buildSectorMap } from '../../games/sector-expedition/src/content.js';
import { runAction } from '../../packages/core/src/runAction.js';

// --- Methodology note (read before trusting any number this prints) -----
//
// Two real code paths inside runAction() (packages/core/src/runAction.js),
// both exercised exactly as shipped, no hand-copied stand-ins:
//   - `nonInPlaceOnlyGame`: a game exposing only `applyAction` (no
//     `applyActionInPlace`) -- what any pack that doesn't implement the
//     in-place entry point pays today: structuredClone() of the whole
//     state, on every single action.
//   - `inPlaceCapableGame`: sectorExpedition as shipped, implementing
//     `applyActionInPlace`. This is no longer an opt-in "structural
//     sharing" flag -- runAction() always hands an `applyActionInPlace`
//     game a live immer draft and structurally shares whatever a given
//     action didn't touch. See the long comment at the top of
//     runAction.js for why this became the mandatory contract instead of
//     an opt-in, and packages/core/test/runAction.structuralSharing.test.js
//     for the tests proving all four shipped games are compliant.
//
// The scaling behaviour below is the actual point of this file: both
// paths clone/copy *something* on every action, but nonInPlaceOnlyGame's
// cost is O(total state size) regardless of what changed, while
// inPlaceCapableGame's cost stays close to flat as state grows, because
// only what a given action actually mutated gets copied.

function inPlaceCapableGame() {
  return sectorExpedition; // implements applyAction AND applyActionInPlace
}

function nonInPlaceOnlyGame() {
  // Same rules, but only the non-in-place entry point is exposed, so
  // runAction() is forced down its other real code path.
  const { applyActionInPlace, ...rest } = sectorExpedition;
  return { ...rest, applyAction: (state, action, context) => sectorExpedition.applyActionInPlace(structuredClone(state), action, context) };
}

function makeLargeState(radius) {
  const base = sectorExpedition.createInitialState({ players: ['A', 'B'], seed: 123 });
  return { ...base, map: buildSectorMap(radius) };
}

function bench(game, state, n) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const action = { type: 'END_TURN', actor: state.activePlayer };
    const r = runAction({ game, state, action, context: { rng: null } });
    if (!r.ok) throw new Error('benchmark action failed: ' + JSON.stringify(r.error));
    state = r.state;
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// This is NOT a code path that exists in runAction.js anymore -- the
// plain-structuredClone in-place branch was removed entirely once
// structural sharing became mandatory for applyActionInPlace games (see
// the long comment at the top of runAction.js for why). It is reproduced
// here, standalone, purely to answer "what changed for a game that
// already implemented applyActionInPlace, compared to before this work":
// one structuredClone() of the whole state per action, then the same
// mutation, matching exactly what the removed branch used to do.
function benchHistoricalPlainCloneInPlace(state, n) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const action = { type: 'END_TURN', actor: state.activePlayer };
    const workingState = structuredClone(state);
    const result = sectorExpedition.applyActionInPlace(workingState, action, { rng: null });
    if (!result || result.state !== workingState) throw new Error('benchmark action failed');
    state = result.state;
  }
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function run(label, radius, n) {
  const tileCount = Object.keys(buildSectorMap(radius)).length;
  const warmup = Math.max(50, Math.floor(n / 10));
  bench(nonInPlaceOnlyGame(), makeLargeState(radius), warmup);
  bench(inPlaceCapableGame(), makeLargeState(radius), warmup);
  benchHistoricalPlainCloneInPlace(makeLargeState(radius), warmup);
  const baseline = bench(nonInPlaceOnlyGame(), makeLargeState(radius), n);
  const inPlace = bench(inPlaceCapableGame(), makeLargeState(radius), n);
  const historicalPlainClone = benchHistoricalPlainCloneInPlace(makeLargeState(radius), n);
  return {
    label, tileCount, actions: n,
    nonInPlaceBaselineMs: baseline,
    historicalPlainCloneInPlaceMs: historicalPlainClone,
    inPlaceStructuralSharingMs: inPlace,
    speedupVsNonInPlace: baseline / inPlace,
    speedupVsHistoricalInPlace: historicalPlainClone / inPlace,
  };
}

const results = [
  run('default (radius 2, matches the shipped game)', 2, 5000),
  run('large map (radius 20, ~1261 tiles)', 20, 3000),
  run('huge map (radius 35, ~3781 tiles)', 35, 800),
];

console.log(JSON.stringify(results, null, 2));
console.log('\nspeedupVsHistoricalInPlace is the actual before/after for a game that already implemented applyActionInPlace:');
console.log('it grows with map size instead of staying flat, because the historical path was O(total state size) per action');
console.log('regardless of what changed, and the current mandatory path only copies what a given action actually mutated.');
console.log('speedupVsNonInPlace is the separate, larger question of "why implement applyActionInPlace at all".');
