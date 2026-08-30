import test from 'node:test';
import assert from 'node:assert/strict';
import { gridDuel } from '@tablecore/game-grid-duel';
import { createMatch, startMatch, dispatchMatchAction, abortMatch } from '../src/match/createMatch.js';

test('match starts from lobby and owns lifecycle state', () => {
  const lobby = createMatch({ id:'m1', game:gridDuel, players:['A','B'] });
  assert.equal(lobby.status, 'lobby');
  const started = startMatch({ match:lobby, game:gridDuel });
  assert.equal(started.ok, true); assert.equal(started.match.status, 'running');
  assert.equal(started.match.state.activePlayer, 'A');
  assert.equal(started.match.version, 1);
});

test('actions are rejected before match starts', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'] });
  const r = dispatchMatchAction({ match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'MATCH_NOT_RUNNING');
});

test('finished game closes match and blocks future actions', () => {
  let match = startMatch({ match:createMatch({game:gridDuel,players:['A','B']}), game:gridDuel }).match;
  // Put players adjacent and one hit from defeat; lifecycle layer must not contain game rules.
  match = structuredClone(match); match.state.players.A.position={x:0,y:0}; match.state.players.B.position={x:1,y:0}; match.state.players.B.hp=1;
  const r = dispatchMatchAction({ match, game:gridDuel, action:{type:'ATTACK',actor:'A'} });
  assert.equal(r.ok, true); assert.equal(r.match.status, 'finished'); assert.equal(r.match.result.winner, 'A');
  assert.ok(r.events.some(e=>e.type==='MATCH_FINISHED'));
  const blocked = dispatchMatchAction({ match:r.match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });
  assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'MATCH_NOT_RUNNING');
});

test('abort is explicit and does not mutate finished matches', () => {
  const match = startMatch({ match:createMatch({game:gridDuel,players:['A','B']}), game:gridDuel }).match;
  const r = abortMatch({ match, reason:'HOST_STOPPED' }); assert.equal(r.ok, true); assert.equal(r.match.status,'aborted');
  const again = abortMatch({ match:{...r.match,status:'finished'} }); assert.equal(again.ok,false);
});

// Regression tests: createMatch() used to accept any array of players
// with no format, uniqueness, or count validation at all -- duplicate
// ids, empty strings, non-string values, and unbounded participant counts
// all passed silently. This is directly what enabled the ServerHost
// cache-key collision (a player id equal to '__spectator__') and left
// every downstream assumption ("participants are unique stable
// identities") unenforced.
test('createMatch rejects duplicate player ids', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A','A'] }), TypeError);
});

test('createMatch rejects empty-string, non-string, and malformed player ids', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A',''] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', 123] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', null] }), TypeError);
  assert.throws(() => createMatch({ game:gridDuel, players:['A', '<script>'] }), TypeError);
});

test('createMatch rejects an excessive player count', () => {
  const players = Array.from({ length: 17 }, (_, i) => `p${i}`);
  assert.throws(() => createMatch({ game:gridDuel, players }), TypeError);
});

test('createMatch accepts well-formed, unique player ids including edge-case-looking-but-valid ones', () => {
  // '__spectator__' is a syntactically valid id under the format rule --
  // the fix for the collision it caused lives in ServerHost's cache key
  // prefixing, not in rejecting this specific string here, since the
  // format rule can't enumerate every reserved-looking string a future
  // internal sentinel might use.
  assert.doesNotThrow(() => createMatch({ game:gridDuel, players:['__spectator__','B'] }));
});

// MIG-03 (external migration-derived review request): "hold a reference to
// createMatch/dispatchMatchAction/abortMatch result, mutate it after
// return, and verify the internal authoritative match did not change."
// `.players` used to be the exact same array reference across every
// lifecycle transition (never copied after the initial createMatch()
// call) -- a caller mutating ANY one returned match object's `.players`
// silently corrupted every match snapshot ever derived from it, past and
// future, since they all aliased one array. Now frozen: the mutation
// attempt throws instead of silently succeeding.
test('mutating .players on any returned match object throws instead of silently corrupting every other match snapshot', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'] });
  const started = startMatch({ match:original, game:gridDuel });
  const dispatched = dispatchMatchAction({ match:started.match, game:gridDuel, action:{type:'MOVE',actor:'A',direction:'E'} });

  assert.throws(() => { dispatched.match.players.push('INJECTED'); }, TypeError);
  assert.deepEqual(original.players, ['A','B'], 'the original match object must be completely unaffected by the throwing mutation attempt');
  assert.deepEqual(started.match.players, ['A','B']);
  assert.deepEqual(dispatched.match.players, ['A','B']);
});

test('mutating .options on any returned match object throws instead of silently corrupting every other match snapshot', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'], options:{ seed:1, mode:'ranked' } });
  const started = startMatch({ match:original, game:gridDuel });
  assert.throws(() => { started.match.options.mode = 'casual'; }, TypeError);
  assert.equal(original.options.mode, 'ranked');
});

// MIG-03's other required case: a failed action transition must not
// partially mutate the old match. dispatchMatchAction already returns
// `{ ...result, match }` (the ORIGINAL match, unchanged) on failure --
// this asserts that explicitly, plus that the original object's own
// fields are untouched.
test('a rejected action does not mutate the authoritative match object at all', () => {
  const original = createMatch({ game:gridDuel, players:['A','B'] });
  const started = startMatch({ match:original, game:gridDuel });
  const before = structuredClone(started.match);
  const rejected = dispatchMatchAction({ match:started.match, game:gridDuel, action:{type:'MOVE',actor:'B',direction:'E'} }); // B is not the active player
  assert.equal(rejected.ok, false);
  assert.equal(rejected.match, started.match, 'on rejection, the exact same match reference is returned, not a mutated copy');
  assert.deepEqual(started.match, before, 'the match object itself must be byte-for-byte unchanged after a rejected action');
});

// Regression tests: createMatch() used to have no concept of a spectator
// policy at all -- access control for anonymous viewers lived entirely
// at the protocol layer's optional `connection.allowedMatches`, which
// defaulted to "allow" when unset. `spectatorPolicy` makes the match
// itself the source of truth, defaulting to deny.
test('createMatch defaults spectatorPolicy to deny', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'] });
  assert.equal(match.spectatorPolicy, 'deny');
});

test('createMatch rejects an invalid spectatorPolicy value', () => {
  assert.throws(() => createMatch({ game:gridDuel, players:['A','B'], spectatorPolicy:'yes-please' }), TypeError);
});

test('createMatch accepts an explicit public spectatorPolicy', () => {
  const match = createMatch({ game:gridDuel, players:['A','B'], spectatorPolicy:'public' });
  assert.equal(match.spectatorPolicy, 'public');
});
