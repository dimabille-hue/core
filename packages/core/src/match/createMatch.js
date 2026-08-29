import { runAction } from '../runAction.js';
import { createSeededRng } from '../rng/SeededRng.js';

const clone = (value) => structuredClone(value);

// Canonical player-id format for this engine. Defined here (in core, the
// most foundational package) rather than in packages/protocol, so that
// protocol/auth's token issuance can import and reuse this single
// definition instead of maintaining its own copy that could drift out of
// sync -- there is exactly one legitimate shape for a player id, checked
// in exactly one place, at both the point a match is created AND the
// point a token is issued for one.
export const PLAYER_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PLAYERS = 16;

export function createMatch({ id, game, players = [], options = {}, spectatorPolicy = 'deny' }) {
  if (!game || typeof game.createInitialState !== 'function' || typeof game.getGameStatus !== 'function') {
    throw new TypeError('Game must implement createInitialState and getGameStatus');
  }
  if (!Array.isArray(players) || players.length < 1) throw new TypeError('Match requires players');
  if (players.length > MAX_PLAYERS) throw new TypeError(`Match players exceeds maximum of ${MAX_PLAYERS}`);
  if (!players.every(p => typeof p === 'string' && PLAYER_ID_RE.test(p))) {
    throw new TypeError(`Every player id must be a non-empty string matching ${PLAYER_ID_RE}`);
  }
  if (new Set(players).size !== players.length) throw new TypeError('Player ids must be unique');
  const SPECTATOR_POLICIES = new Set(['deny', 'public']);
  if (!SPECTATOR_POLICIES.has(spectatorPolicy)) throw new TypeError(`spectatorPolicy must be one of ${[...SPECTATOR_POLICIES].join('|')}`);
  return {
    id: id ?? `match-${Date.now()}`,
    status: 'lobby',
    // Frozen, not just copied: `players` is never reassigned by any
    // lifecycle transition below (startMatch/dispatchMatchAction/
    // abortMatch all shallow-spread `{...match, ...}`, which carries this
    // exact array reference forward, unchanged, across the match's entire
    // lifetime). A caller who mutates a `.players` array obtained from any
    // one returned match object -- `result.match.players.push(...)` --
    // would otherwise silently corrupt every match snapshot ever derived
    // from it, past and future, since they all alias the same array.
    // ServerHost's own external API is already safe (it always returns a
    // fresh structuredClone()), but these core primitives are usable
    // directly, and match participants are immutable for a match's entire
    // lifetime by design (no add/remove-player feature exists) -- so
    // freezing turns an accidental mutation into a loud, immediate
    // TypeError at the mutation site instead of silent, hard-to-trace
    // state corruption.
    players: Object.freeze([...players]),
    // Default deny, not "allow unless configured otherwise": a common,
    // dangerous pattern elsewhere in transport/auth code is "ACL
    // undefined => allow" (see the spectator-access fail-open finding
    // this replaces). Infrastructure code should default the other way --
    // absence of an explicit grant means no access. A match that wants
    // to be spectatable (a public broadcast, a "watch this game" feature)
    // has to say so explicitly at creation time.
    spectatorPolicy,
    state: null,
    result: null,
    version: 0,
    seed: Number(options.seed ?? 0) >>> 0,
    rngState: null,
    // Same reasoning as `players`: never reassigned after creation, so
    // frozen to fail loud rather than silently alias-corrupt every
    // subsequent match snapshot.
    options: Object.freeze(clone(options)),
    events: [{ type: 'MATCH_CREATED' }],
  };
}

export function startMatch({ match, game, context = {} }) {
  if (match.status !== 'lobby') return { ok: false, error: { code: 'MATCH_NOT_STARTABLE' }, match };
  const rng = createSeededRng(match.seed);
  const state = game.createInitialState({ players: match.players, ...match.options, ...context });
  const next = { ...match, status: 'running', state, version: match.version + 1, rngState: rng.getState() };
  const events = [{ type: 'MATCH_STARTED', players: [...next.players] }];
  next.events = [...match.events, ...events];
  return { ok: true, match: next, events };
}

export function dispatchMatchAction({ match, game, action, context = {} }) {
  if (match.status !== 'running') return { ok: false, error: { code: 'MATCH_NOT_RUNNING' }, match };
  const rng = createSeededRng(match.seed, match.rngState ?? match.seed);
  const result = runAction({
    game,
    state: match.state,
    action,
    context: { ...context, rng, seed: match.seed },
  });
  if (!result.ok) return { ...result, match };
  const next = { ...match, state: result.state, version: match.version + 1, rngState: rng.getState() };
  const status = game.getGameStatus(result.state);
  const lifecycleEvents = [];
  if (status?.finished) {
    next.status = 'finished';
    next.result = { winner: status.winner ?? null };
    lifecycleEvents.push({ type: 'MATCH_FINISHED', result: clone(next.result) });
  }
  const events = [...result.events, ...lifecycleEvents];
  next.events = [...match.events, ...events];
  return { ok: true, match: next, events };
}

export function abortMatch({ match, reason = 'ABORTED' }) {
  if (match.status === 'finished') return { ok: false, error: { code: 'MATCH_ALREADY_FINISHED' }, match };
  const next = { ...match, status: 'aborted', result: { reason }, version: match.version + 1 };
  const events = [{ type: 'MATCH_ABORTED', reason }];
  next.events = [...match.events, ...events];
  return { ok: true, match: next, events };
}
