import { produce, enableMapSet } from 'immer';

// Any game whose state uses Map/Set as an authoritative container (a
// completely reasonable choice -- e.g. entities keyed by id) needs immer's
// MapSet plugin enabled, or every draft mutation of a Map/Set throws
// `[Immer] The plugin for 'MapSet' has not been loaded`. This is a
// one-time, idempotent, process-global registration -- exactly the kind
// of Immer implementation detail a game pack should never have to know
// about or remember to call itself (see ARCHITECTURE.md: the engine owns
// the contract, and the contract should be easy to satisfy, not leak
// "you must also call this unrelated setup function from the state
// library we happen to use internally" onto every pack author). Enabling
// it here, once, centrally, means any game can freely use Map/Set in its
// state with zero awareness that immer is involved at all.
enableMapSet();

// --- The applyActionInPlace contract ------------------------------------
//
// A game that implements `applyActionInPlace(state, action, context)` is
// handed an immer *draft*, not a plain mutable object. Reads, writes,
// array methods, Object.* operations and spreads all work transparently
// on a draft exactly like a plain object (that's the whole point of
// immer) -- this is why `applyActionInPlace` was always written to "just
// mutate `state` and return it", and that code does not need to change.
//
// This used to be optional (`useStructuralSharing`, only on request)
// specifically to avoid silently breaking existing rule code that called
// `structuredClone()`/a local `clone()` helper on values read from
// `state`. That escape hatch is gone: this codebase already dictates
// several other hard constraints on rule code for the same underlying
// reason (execution.js rejects async rule functions; pack-lint rejects
// Math.random()/Date.now() in rule code -- see packages/pack-linter/src/
// index.js) -- determinism and correctness are the engine's job to
// enforce, not something every pack author re-derives independently. This
// is the same policy, extended to one more rule: **never call
// structuredClone()/clone() on a value read from `state` inside
// applyActionInPlace.** structuredClone() cannot walk an immer draft
// under any circumstances (verified directly: DataCloneError, live or
// already finalized) -- there is no safe way to "opt out" of this
// per-call, so it is enforced structurally instead:
//   - pack-lint's static checks additionally flag any
//     `structuredClone(`/`clone(` call appearing inside the text of
//     `applyActionInPlace` as a blocking finding (see pack-linter).
//   - if a game still gets this wrong, `runAction` fails CLOSED with
//     GAME_EXECUTION_ERROR and the original state is left untouched --
//     never silent corruption.
//   - if a rule genuinely needs an explicit plain snapshot of part of the
//     draft, use a plain spread (`{...draft.player.position}`, which
//     reads through the draft's own proxy traps correctly) or immer's own
//     `current()`.
//
// `events` gets the same treatment for a related reason: a common,
// legitimate pattern is capturing a reference into the state tree inside
// an event payload (`const from = actor.position; ...;
// events.push({from})`, exactly what games/grid-duel/src/game.js does).
// Those captured values are live immer proxies that get revoked the
// instant the recipe below returns. Resolving `events` via a JSON
// round-trip *while still inside the recipe* (before revocation) makes
// that pattern safe without requiring any game to special-case its event
// payloads -- events are meant to be JSON-safe wire data anyway (they are
// sent over the network as JSON), so this is not a weaker guarantee than
// the old structuredClone() was providing for this specific data.
//
// Real, measured performance numbers for why this is worth being strict
// about instead of just leaving it optional: tools/performance/
// benchmark.mjs, run against this engine's own game shape at increasing
// state sizes. At the size of the currently-shipped demo games the
// difference against a naive full clone is small; it grows to 5x+ and
// keeps growing, unbounded, as state grows -- any card/board game with a
// meaningfully large state (a wide map, a large hand/zone collection,
// many players) pays the O(state size) cost on literally every move
// without this.
export function runAction({ game, state, action, context = {} }) {
  if (!game || (typeof game.applyAction !== 'function' && typeof game.applyActionInPlace !== 'function')) throw new TypeError('Game must implement applyAction');
  if (!action || typeof action.type !== 'string') return { ok:false, error:{ code:'INVALID_ACTION' } };
  const legal = game.getLegalActions?.(state, action.actor) ?? [];
  const isLegal = legal.some(a => a && a.type === action.type);
  if (!isLegal) return { ok:false, error:{ code:'ILLEGAL_ACTION' } };
  if (typeof game.validateAction === 'function') {
    const validation = game.validateAction(state, action, context);
    if (validation !== true && validation !== undefined) {
      const error = typeof validation === 'string' ? { code: validation } : (validation?.code ? validation : { code: 'INVALID_ACTION' });
      return { ok:false, error };
    }
  }
  const safeAction = structuredClone(action);

  if (typeof game.applyActionInPlace === 'function') {
    let mutationResult = null;
    let draftIdentity = null;
    let safeEvents = null;
    let nextState;
    try {
      nextState = produce(state, draft => {
        draftIdentity = draft;
        mutationResult = game.applyActionInPlace(draft, safeAction, context);
        // No `return` here: an immer recipe that returns a value REPLACES
        // the draft-tracked result entirely, discarding structural
        // sharing. We want immer to finalize based on what was mutated on
        // `draft`, so the recipe's own return value (the game's {state,
        // events} object) is deliberately ignored here and read back out
        // via the `mutationResult` closure variable instead.
        if (mutationResult && Array.isArray(mutationResult.events)) {
          safeEvents = JSON.parse(JSON.stringify(mutationResult.events));
        }
      });
    } catch (error) {
      return { ok:false, error:{ code:'GAME_EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error) } };
    }
    if (!mutationResult || !mutationResult.state || safeEvents === null) {
      return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
    }
    if (mutationResult.accepted === false || mutationResult.ok === false) {
      return { ok:false, error:mutationResult.error ?? { code:'ACTION_REJECTED' } };
    }
    if (safeEvents.some(event => event && event.type === 'ACTION_REJECTED')) {
      const rejection = safeEvents.find(event => event && event.type === 'ACTION_REJECTED');
      return { ok:false, error:{ code: rejection.code ?? 'ACTION_REJECTED' } };
    }
    // The game must mutate and return the exact object it was handed
    // (here, the draft), not swap in something else. Reference-equality
    // on a (by now finalized/revoked) proxy is safe -- revocation breaks
    // property traps, not identity comparison.
    if (mutationResult.state !== draftIdentity) return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
    return { ok:true, state:nextState, events:safeEvents };
  }

  // A game that only implements the non-in-place `applyAction` builds its
  // own fresh state independently and is never handed a draft, so none of
  // the above applies -- this path is unrelated to immer entirely.
  const workingState = structuredClone(state);
  let result;
  try {
    result = game.applyAction(workingState, safeAction, context);
  } catch (error) {
    return { ok:false, error:{ code:'GAME_EXECUTION_ERROR', message:error instanceof Error ? error.message : String(error) } };
  }
  if (!result || !result.state || !Array.isArray(result.events)) {
    return { ok:false, error:{ code:'GAME_CONTRACT_VIOLATION' } };
  }
  if (result.accepted === false || result.ok === false) {
    return { ok:false, error:result.error ?? { code:'ACTION_REJECTED' } };
  }
  if (result.events.some(event => event && event.type === 'ACTION_REJECTED')) {
    const rejection = result.events.find(event => event && event.type === 'ACTION_REJECTED');
    return { ok:false, error:{ code: rejection.code ?? 'ACTION_REJECTED' } };
  }
  return { ok:true, state:structuredClone(result.state), events:structuredClone(result.events) };
}
