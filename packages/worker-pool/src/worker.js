// Runs inside a worker_thread. Hosts a subset of matches (whichever ones
// were routed to this worker by MatchWorkerPool's hash(matchId) ->
// worker affinity) using the exact same core primitives ServerHost uses
// in-process (createMatch/startMatch/dispatchMatchAction/getSnapshot-
// equivalent projection) -- this is not a reimplementation of match
// logic, it is the same logic, just given its own thread and its own V8
// isolate.
//
// Why this exists (P1-MATCH, external remediation request section 23,
// and the concrete crash PoC that motivated it): Node is single-threaded.
// Before this, ALL matches, in every deployment using this engine's
// in-process ServerHost, shared one event loop. A demonstrated, real bug
// -- a game rule that schedules a deferred mutation of its own state
// (`setTimeout(() => { state.value = 999 }, 50)`, an ordinary programming
// mistake, not malice) -- throws an uncaught exception once the timer
// fires, because by then immer has already finalized and revoked the
// draft. An uncaught exception in Node crashes the entire process by
// default: every match, every connected player, gone, because of a bug
// in ONE match's rules. Running each worker's matches in their own
// thread, with the main thread listening for the worker's 'error' event,
// means a crash like that terminates only the matches hosted on THAT
// worker -- the main process and every other worker's matches are
// unaffected. This is verified directly, not just asserted: see
// packages/worker-pool/test/MatchWorkerPool.test.js's crash-isolation
// test, built on the exact same time-bomb pattern.
import { parentPort } from 'node:worker_threads';
import { createMatch, startMatch, dispatchMatchAction, abortMatch } from '@tablecore/core';

const matches = new Map(); // matchId -> { game, match, snapshotCache: Map<viewerKey, {version,snapshot}> }
const gameCache = new Map(); // `${moduleUrl}#${exportName}` -> game definition

async function loadGame(moduleUrl, exportName) {
  const key = `${moduleUrl}#${exportName ?? ''}`;
  if (gameCache.has(key)) return gameCache.get(key);
  const mod = await import(moduleUrl);
  const game = exportName ? mod[exportName] : mod.default;
  if (!game) throw new Error(`Game export "${exportName ?? 'default'}" not found in ${moduleUrl}`);
  gameCache.set(key, game);
  return game;
}

function clone(v) { return structuredClone(v); }

function projectSnapshot(entry, viewer) {
  const viewerKey = viewer == null ? 'spectator:' : `player:${String(viewer)}`;
  const cached = entry.snapshotCache.get(viewerKey);
  if (cached && cached.version === entry.match.version) return clone(cached.snapshot);
  const { id, status, players, state, result, version, spectatorPolicy } = entry.match;
  const projectedState = state == null ? null : (typeof entry.game.getPlayerView === 'function' ? entry.game.getPlayerView(state, viewer) : state);
  const snapshot = { id, status, players, state: projectedState, result, version, spectatorPolicy };
  entry.snapshotCache.set(viewerKey, { version, snapshot });
  return clone(snapshot);
}

async function handle(message) {
  const { type, payload } = message;
  switch (type) {
    case 'CREATE_MATCH': {
      const game = await loadGame(payload.gameModuleUrl, payload.gameExportName);
      const match = createMatch({ id: payload.matchId, game, players: payload.players, options: payload.options, spectatorPolicy: payload.spectatorPolicy });
      matches.set(payload.matchId, { game, match, snapshotCache: new Map() });
      return { ok: true, match: clone(match) };
    }
    case 'START_MATCH': {
      const entry = matches.get(payload.matchId);
      if (!entry) return { ok: false, error: { code: 'MATCH_NOT_FOUND' } };
      if (payload.actor != null && !entry.match.players.includes(payload.actor)) return { ok: false, error: { code: 'NOT_MATCH_PARTICIPANT' } };
      const r = startMatch({ match: entry.match, game: entry.game });
      if (r.ok) { entry.match = r.match; entry.snapshotCache.clear(); }
      return r.ok ? { ok: true, match: clone(r.match) } : r;
    }
    case 'GET_SNAPSHOT': {
      const entry = matches.get(payload.matchId);
      if (!entry) return { ok: false, error: { code: 'MATCH_NOT_FOUND' } };
      return { ok: true, snapshot: projectSnapshot(entry, payload.viewer ?? null) };
    }
    case 'SUBMIT_ACTION': {
      const entry = matches.get(payload.matchId);
      if (!entry) return { ok: false, error: { code: 'MATCH_NOT_FOUND' } };
      if (!entry.match.players.includes(payload.connectionPlayerId)) return { ok: false, error: { code: 'NOT_MATCH_PARTICIPANT' } };
      if (payload.actor !== payload.connectionPlayerId) return { ok: false, error: { code: 'ACTOR_SPOOFING' } };
      if (payload.expectedVersion !== entry.match.version) return { ok: false, error: { code: 'STALE_VERSION' }, snapshot: projectSnapshot(entry, payload.connectionPlayerId) };
      const normalized = { ...clone(payload.action), actor: payload.connectionPlayerId };
      const result = dispatchMatchAction({ match: entry.match, game: entry.game, action: normalized });
      if (!result.ok) return { ok: false, error: result.error, snapshot: projectSnapshot(entry, payload.connectionPlayerId) };
      entry.match = result.match;
      entry.snapshotCache.clear();
      return { ok: true, version: entry.match.version, events: clone(result.events), snapshot: projectSnapshot(entry, payload.connectionPlayerId) };
    }
    case 'ABORT_MATCH': {
      const entry = matches.get(payload.matchId);
      if (!entry) return { ok: false, error: { code: 'MATCH_NOT_FOUND' } };
      const r = abortMatch({ match: entry.match, reason: payload.reason });
      if (r.ok) { entry.match = r.match; entry.snapshotCache.clear(); }
      return r.ok ? { ok: true, match: clone(r.match) } : r;
    }
    default:
      return { ok: false, error: { code: 'UNKNOWN_MESSAGE_TYPE' } };
  }
}

parentPort.on('message', async message => {
  const { id } = message;
  try {
    const result = await handle(message);
    parentPort.postMessage({ id, ...result });
  } catch (error) {
    // A synchronous throw inside handle() (e.g. a bad createMatch() call)
    // is caught here and reported as a normal RPC failure -- the worker
    // stays alive. This does NOT catch a deferred/async throw (a
    // setTimeout firing after this handler already returned) -- nothing
    // in JS can catch that from the throw site's own call stack, by
    // construction. That class of failure surfaces instead as this
    // worker's 'error' event on the MAIN thread, which is exactly the
    // isolation boundary this whole package exists to provide: it takes
    // this worker down (and whichever matches it was hosting), not the
    // process hosting every other worker.
    parentPort.postMessage({ id, ok: false, error: { code: 'MATCH_EXECUTION_ERROR', message: error instanceof Error ? error.message : String(error) } });
  }
});
