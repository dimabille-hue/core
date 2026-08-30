import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MatchWorkerPool } from '../src/index.js';

const GRID_DUEL_URL = new URL('../../../games/grid-duel/src/index.js', import.meta.url).href;
const TIME_BOMB_URL = new URL('../../../games/timebomb-test/src/index.js', import.meta.url).href;
const MEMORY_HOG_URL = new URL('../../../games/memory-hog-test/src/index.js', import.meta.url).href;
const INFINITE_LOOP_URL = new URL('../../../games/infinite-loop-test/src/index.js', import.meta.url).href;

function hashToIndex(matchId, poolSize) {
  return createHash('sha256').update(String(matchId)).digest().readUInt32BE(0) % poolSize;
}

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); }
  return fn();
}

// Find real match ids that land on distinct worker indices for a given
// pool size, rather than hardcoding ids that happen to work today --
// this stays correct if the hash function's exact distribution ever
// changes.
function idsOnDistinctWorkers(poolSize, count) {
  const found = new Map();
  for (let i = 0; found.size < count && i < 100000; i++) {
    const id = `match-${i}`;
    const idx = hashToIndex(id, poolSize);
    if (!found.has(idx)) found.set(idx, id);
  }
  if (found.size < count) throw new Error('could not find enough distinct-worker ids');
  return [...found.values()];
}

test('createMatch/startMatch/submitAction work correctly end-to-end through the pool', async () => {
  const pool = new MatchWorkerPool({ poolSize: 2 });
  try {
    const created = await pool.createMatch({ id: 'm1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(created.ok, true);
    const started = await pool.startMatch({ matchId: 'm1', actor: 'A' });
    assert.equal(started.ok, true);
    assert.equal(started.match.status, 'running');
    const snap = await pool.getSnapshot('m1', 'A');
    assert.equal(snap.ok, true);
    const r = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.snapshot.state.players.A.position, { x: 1, y: 0 });
  } finally {
    await pool.close();
  }
});

test('a match consistently routes to the same worker across every call (required for in-match action ordering)', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    await pool.createMatch({ id: 'consistent-routing', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    const expected = pool._indexFor('consistent-routing');
    // Every subsequent lookup for the same matchId must agree, including
    // ones happening after other matches have been created (which must
    // not perturb existing routing).
    await pool.createMatch({ id: 'other-match-1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.createMatch({ id: 'other-match-2', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(pool._indexFor('consistent-routing'), expected);
  } finally {
    await pool.close();
  }
});

test('actor spoofing and non-participant access are rejected the same way as ServerHost', async () => {
  const pool = new MatchWorkerPool({ poolSize: 1 });
  try {
    await pool.createMatch({ id: 'm1', gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: 'm1', actor: 'A' });
    const snap = await pool.getSnapshot('m1', 'A');
    const spoofed = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'A', actor: 'B', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(spoofed.ok, false);
    assert.equal(spoofed.error.code, 'ACTOR_SPOOFING');
    const outsider = await pool.submitAction({ matchId: 'm1', connectionPlayerId: 'X', actor: 'X', expectedVersion: snap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(outsider.ok, false);
    assert.equal(outsider.error.code, 'NOT_MATCH_PARTICIPANT');
  } finally {
    await pool.close();
  }
});

// The core property this whole package exists for (P1-MATCH, external
// remediation request section 23; and the concrete PoC from the audit
// that motivated it): a rule that schedules a deferred mutation of its
// own state throws an uncaught exception once the timer fires (the
// immer draft is already finalized/revoked by then) -- run in-process,
// this crashes the ENTIRE server. Run inside a worker, it must only
// crash that one worker.
test('a match whose rule code crashes its worker (deferred mutation of a revoked draft) does not affect a match on a different worker, or the main process', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    const [bombId, safeId] = idsOnDistinctWorkers(4, 2);
    assert.notEqual(hashToIndex(bombId, 4), hashToIndex(safeId, 4), 'test precondition: these two ids must land on different workers');

    await pool.createMatch({ id: bombId, gameModuleUrl: TIME_BOMB_URL, gameExportName: 'timeBombGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: bombId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    const bombSnap = await pool.getSnapshot(bombId, 'A');
    const armed = await pool.submitAction({ matchId: bombId, connectionPlayerId: 'A', actor: 'A', expectedVersion: bombSnap.snapshot.version, action: { type: 'ARM' } });
    assert.equal(armed.ok, true, 'arming the bomb is itself a normal, successful action -- the crash is deferred');

    // Give the timer time to fire and crash the bomb's worker.
    await new Promise(r => setTimeout(r, 300));

    assert.equal(pool.wasLostToCrash(bombId), true, 'the bomb match must be reported as lost to a crash');
    assert.equal(pool.wasLostToCrash(safeId), false, 'the safe match, on a different worker, must not be affected at all');

    // The real proof: the safe match keeps working normally AFTER the
    // other worker crashed. If this test process itself had crashed,
    // nothing below this line would ever run at all.
    const safeSnap = await pool.getSnapshot(safeId, 'A');
    assert.equal(safeSnap.ok, true);
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.snapshot.state.players.A.position, { x: 1, y: 0 });
  } finally {
    await pool.close();
  }
});

test('the pool respawns a replacement worker after a crash, so new matches can still be routed to that pool slot', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4 });
  try {
    const [bombId] = idsOnDistinctWorkers(4, 1);
    const crashedWorkerIndex = hashToIndex(bombId, 4);

    await pool.createMatch({ id: bombId, gameModuleUrl: TIME_BOMB_URL, gameExportName: 'timeBombGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: bombId, actor: 'A' });
    const snap = await pool.getSnapshot(bombId, 'A');
    await pool.submitAction({ matchId: bombId, connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'ARM' } });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(pool.wasLostToCrash(bombId), true);

    // A brand new match that hashes to the SAME slot must work on the
    // freshly-spawned replacement worker, not hang forever waiting on a
    // dead one.
    let freshId = null;
    for (let i = 0; i < 100000; i++) {
      const candidate = `fresh-${i}`;
      if (hashToIndex(candidate, 4) === crashedWorkerIndex) { freshId = candidate; break; }
    }
    assert.ok(freshId, 'test precondition: found an id routing to the crashed slot');
    const created = await pool.createMatch({ id: freshId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    assert.equal(created.ok, true, 'the respawned worker must serve new matches routed to its slot');
  } finally {
    await pool.close();
  }
});

// P0-SANDBOX (external remediation request): "a valid signature does not
// make an executable Game Pack safe... CPU overrun terminates the pack
// execution without taking down the gateway; memory overrun terminates/
// restarts the pack worker." These two tests are the honest, real,
// verifiable subset of that: V8-enforced memory ceilings via
// worker_threads' own `resourceLimits`, and this pool's own CPU watchdog
// (`rpcTimeoutMs`) for a runaway synchronous loop. See MatchWorkerPool.js's
// class doc comment for what this explicitly does NOT provide (filesystem/
// network/env capability restriction -- that needs real OS-level process
// isolation, out of scope for a worker_thread).

test('a match that keeps allocating memory is killed once it exceeds resourceLimits, without affecting a match on a different worker', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4, resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 } });
  try {
    const [hogId, safeId] = idsOnDistinctWorkers(4, 2);
    await pool.createMatch({ id: hogId, gameModuleUrl: MEMORY_HOG_URL, gameExportName: 'memoryHogGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: hogId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    // Keep allocating until the worker gets killed (or give up after a
    // generous cap so a misconfigured limit can't hang the test forever).
    let lost = false;
    for (let i = 0; i < 60 && !lost; i++) {
      const snap = await pool.getSnapshot(hogId, 'A').catch(() => null);
      if (!snap || !snap.ok) { lost = true; break; }
      const r = await pool.submitAction({ matchId: hogId, connectionPlayerId: 'A', actor: 'A', expectedVersion: snap.snapshot.version, action: { type: 'ALLOCATE' } }).catch(() => ({ ok: false }));
      if (!r.ok) lost = true;
    }

    assert.equal(await waitFor(() => pool.wasLostToCrash(hogId), 5000), true, 'the memory-hogging match must eventually be lost once its worker is killed for exceeding resourceLimits');
    assert.equal(pool.wasLostToCrash(safeId), false, 'a match on a different worker must be completely unaffected by the memory kill');

    const safeSnap = await pool.getSnapshot(safeId, 'A');
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true, 'the safe match keeps working normally after the other worker was killed for memory overrun');
  } finally {
    await pool.close();
  }
});

test('a match whose rule code runs a synchronous infinite loop is retired by the CPU watchdog (rpcTimeoutMs), without affecting a match on a different worker', async () => {
  const pool = new MatchWorkerPool({ poolSize: 4, rpcTimeoutMs: 300 });
  try {
    const [hangId, safeId] = idsOnDistinctWorkers(4, 2);
    await pool.createMatch({ id: hangId, gameModuleUrl: INFINITE_LOOP_URL, gameExportName: 'infiniteLoopGame', players: ['A', 'B'] });
    await pool.startMatch({ matchId: hangId, actor: 'A' });
    await pool.createMatch({ id: safeId, gameModuleUrl: GRID_DUEL_URL, gameExportName: 'gridDuel', players: ['A', 'B'] });
    await pool.startMatch({ matchId: safeId, actor: 'A' });

    const hangSnap = await pool.getSnapshot(hangId, 'A');
    // This call itself never resolves normally -- the watchdog rejects it
    // once rpcTimeoutMs elapses, which is the actual behavior under test.
    await assert.rejects(() => pool.submitAction({ matchId: hangId, connectionPlayerId: 'A', actor: 'A', expectedVersion: hangSnap.snapshot.version, action: { type: 'HANG' } }));

    assert.equal(pool.wasLostToCrash(hangId), true, 'the hung match must be marked lost once the watchdog fires');
    assert.equal(pool.lossReasonFor(hangId), 'cpu-timeout');
    assert.equal(pool.wasLostToCrash(safeId), false, 'a match on a different worker must be completely unaffected by the CPU watchdog firing elsewhere');

    const safeSnap = await pool.getSnapshot(safeId, 'A');
    const r = await pool.submitAction({ matchId: safeId, connectionPlayerId: 'A', actor: 'A', expectedVersion: safeSnap.snapshot.version, action: { type: 'MOVE', direction: 'E' } });
    assert.equal(r.ok, true, 'the safe match keeps working normally after the other worker was retired for a CPU timeout');
  } finally {
    await pool.close();
  }
});
