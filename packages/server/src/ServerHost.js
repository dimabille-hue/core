import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';
import { createMetricsRegistry } from '@tablecore/observability';

const clone = (v) => structuredClone(v);

export class ServerHost {
  constructor() {
    this.matches = new Map();
    // Game-category metrics (P2-OPS): before this, ServerHost tracked
    // nothing about its own match-lifecycle activity at all -- no way to
    // answer "how many matches has this process handled" or "how many
    // actions are being rejected" without instrumenting call sites
    // externally. `activeMatches` is deliberately NOT tracked as an
    // inc/dec counter here (easy to get out of sync if any code path
    // removes a match without going through a single choke point) -- it
    // is computed fresh from `this.matches.size` in getMetrics() instead,
    // which can never drift from the truth.
    this.metrics = createMetricsRegistry({
      matchesCreated: 0,
      matchesStarted: 0,
      matchesFinished: 0,
      actionsAccepted: 0,
      actionsRejected: 0,
    });
    this.startedAt = Date.now();
  }

  /** Game-category metrics snapshot, plus a live (not incrementally-tracked) activeMatches gauge. See packages/observability for the shared registry this uses and buildStructuredMetrics() for combining this with a transport's network metrics into the full {server,game,network,resource} shape. */
  getMetrics() { return Object.freeze({ ...this.metrics.snapshot(), activeMatches: this.matches.size }); }

  createMatch({ id, game, players, options, spectatorPolicy }) {
    if (this.matches.has(id)) return { ok:false, error:{ code:'MATCH_EXISTS' } };
    const match = createMatch({ id, game, players, options, spectatorPolicy });
    this.matches.set(match.id, { game, match, snapshotCache: new Map() });
    this.metrics.inc('matchesCreated');
    return { ok:true, match: clone(match) };
  }

  startMatch({ matchId, actor }) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    if (actor != null && !entry.match.players.includes(actor)) return { ok:false, error:{ code:'NOT_MATCH_PARTICIPANT' } };
    const result = startMatch({ match: entry.match, game: entry.game });
    if (result.ok) { entry.match = result.match; entry.snapshotCache.clear(); this.metrics.inc('matchesStarted'); }
    return result.ok ? { ...result, match: clone(result.match) } : result;
  }

  getSnapshot(matchId, viewer = null) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    // Prefixed, not bare `String(viewer)`: a player id is caller-supplied
    // data (see createMatch's own validation below for the current
    // constraints on it, but this must hold regardless of what player ids
    // are ever allowed to be). A bare sentinel like '__spectator__' for
    // the anonymous-viewer slot can collide with an actual player who
    // happens to be named that -- confirmed directly: a player literally
    // named '__spectator__' populates the spectator cache slot with their
    // OWN correctly-scoped view, which a REAL anonymous spectator then
    // received verbatim on the next request at the same version, leaking
    // that player's own-position data to a spectator who should have seen
    // it redacted. Prefixing with a type tag makes the two key spaces
    // disjoint no matter what a player id string is.
    const viewerKey = viewer == null ? 'spectator:' : `player:${String(viewer)}`;
    const cached = entry.snapshotCache.get(viewerKey);
    if (cached && cached.version === entry.match.version) return { ok:true, snapshot: clone(cached.snapshot) };
    const { id, status, players, state, result, version, spectatorPolicy } = entry.match;
    const projectedState = state == null ? null : (typeof entry.game.getPlayerView === 'function'
      ? entry.game.getPlayerView(state, viewer)
      : state);
    const snapshot = { id, status, players, state: projectedState, result, version, spectatorPolicy };
    entry.snapshotCache.set(viewerKey, { version, snapshot });
    return { ok:true, snapshot: clone(snapshot) };
  }

  submitAction({ matchId, connectionPlayerId, actor, expectedVersion, action }) {
    const entry = this.matches.get(matchId);
    if (!entry) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'MATCH_NOT_FOUND' } }; }
    if (!entry.match.players.includes(connectionPlayerId)) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'NOT_MATCH_PARTICIPANT' } }; }
    if (actor !== connectionPlayerId) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'ACTOR_SPOOFING' } }; }
    if (expectedVersion !== entry.match.version) { this.metrics.inc('actionsRejected'); return { ok:false, error:{ code:'STALE_VERSION' }, snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot }; }
    const normalized = { ...clone(action), actor: connectionPlayerId };
    const wasFinished = entry.match.status === 'finished';
    const result = dispatchMatchAction({ match: entry.match, game: entry.game, action: normalized });
    if (!result.ok) { this.metrics.inc('actionsRejected'); return { ok:false, error:result.error, snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot }; }
    entry.match = result.match;
    entry.snapshotCache.clear();
    this.metrics.inc('actionsAccepted');
    if (!wasFinished && entry.match.status === 'finished') this.metrics.inc('matchesFinished');
    return { ok:true, version:entry.match.version, events:clone(result.events), snapshot:this.getSnapshot(matchId, connectionPlayerId).snapshot };
  }

  getAuthoritativeState(matchId) {
    const entry = this.matches.get(matchId);
    if (!entry) return { ok:false, error:{ code:'MATCH_NOT_FOUND' } };
    return { ok:true, state:clone(entry.match.state), version:entry.match.version };
  }
}
