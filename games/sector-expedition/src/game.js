import { buildSectorMap, directions, mapKey } from './content.js';

const MAX_FUEL = 6;
const START_FUEL = 4;
const START_CREDITS = 1000;
const FUEL_PACK_COST = 500;
const SALVAGE_GOAL = 3;
const MAX_HULL = 3;
const START_HULL = 3;
const EVENT_CHANCE_PERCENT = 25;

const clone = (v) => structuredClone(v);
const other = (players, actor) => players.find(id => id !== actor) ?? actor;
const tileAt = (state, pos) => state.map[mapKey(pos.q,pos.r)] ?? null;
const reveal = (tile, playerId) => {
  if (!tile.revealedBy.includes(playerId)) tile.revealedBy.push(playerId);
};
const adjacent = (a,b) => directions.some(d=>a.q+d.dq===b.q && a.r+d.dr===b.r);

function invalid(code, details) { return details ? { code, details } : { code }; }

export const sectorExpedition = {
  version: 'sector-expedition@1',
  createInitialState({ players=['A','B'], seed=0 }={}) {
    const ids=players.map(p=>typeof p==='string'?p:p.id);
    const map=buildSectorMap();
    for (const tile of Object.values(map)) if (tile.object==='station') tile.revealedBy=[...ids];
    return {
      gameId:'sector-expedition',
      // `seed` is used ONLY right here, synchronously, to derive
      // `activePlayer` deterministically -- it is never read again by any
      // other rule in this file. It is deliberately NOT stored on state:
      // storing server-private simulation input on the one object that
      // flows through getPlayerView()/every snapshot is exactly how it
      // previously leaked to every viewer, including spectators, with the
      // RNG's entire internal state trivially re-derivable from it (see
      // packages/core/src/rng/SeededRng.js -- state is a public,
      // deterministic function of this value). Not storing it at all is a
      // stronger fix than storing-then-redacting in getPlayerView(): it
      // removes the leak vector everywhere, not just on the one code path
      // that currently redacts it.
      turn:0,
      round:1,
      activePlayer:ids[(Number(seed)>>>0)%ids.length],
      phase:'playing',
      winner:null,
      map,
      players:Object.fromEntries(ids.map(id=>[id,{id,position:{q:0,r:0},fuel:START_FUEL,credits:START_CREDITS,salvage:0,hull:START_HULL,scans:0}]))
    };
  },

  getLegalActions(state, actor) {
    if (state.phase!=='playing' || actor!==state.activePlayer) return [];
    return [
      {type:'MOVE'},
      {type:'SCAN'},
      {type:'SALVAGE'},
      {type:'BUY_FUEL'},
      {type:'END_TURN'},
    ];
  },

  validateAction(state, action) {
    const player=state.players[action.actor];
    if (!player) return invalid('UNKNOWN_ACTOR');
    if (state.activePlayer!==action.actor) return invalid('NOT_ACTIVE_PLAYER');
    if (state.phase!=='playing') return invalid('GAME_FINISHED');
    if (action.type==='MOVE') {
      if (!action.target || !Number.isInteger(action.target.q) || !Number.isInteger(action.target.r)) return invalid('INVALID_TARGET');
      const tile=tileAt(state,action.target);
      if (!tile) return invalid('OUT_OF_MAP');
      if (!adjacent(player.position,action.target)) return invalid('NOT_ADJACENT');
      if (player.fuel<1) return invalid('NO_FUEL');
      if (Object.values(state.players).some(p=>p.id!==action.actor&&p.position.q===action.target.q&&p.position.r===action.target.r)) return invalid('OCCUPIED');
      return true;
    }
    if (action.type==='SCAN') return tileAt(state,player.position)?.object==='station' ? true : invalid('SCAN_REQUIRES_STATION');
    if (action.type==='SALVAGE') return tileAt(state,player.position)?.object==='salvage' ? true : invalid('NO_SALVAGE_HERE');
    if (action.type==='BUY_FUEL') return tileAt(state,player.position)?.object==='station' && player.credits>=FUEL_PACK_COST
      ? true : invalid('CANNOT_BUY_FUEL');
    if (action.type==='END_TURN') return true;
    return invalid('UNKNOWN_ACTION');
  },

  applyAction(state, action, context={}) { return this.applyActionInPlace(structuredClone(state), action, context); },
  applyActionInPlace(state, action, context={}) {
    const s=state; const p=s.players[action.actor]; const events=[]; const rng=context.rng;
    if (!p || s.activePlayer!==action.actor || s.phase!=='playing') return {state:s,events:[{type:'ACTION_REJECTED',code:'INVALID_ACTION'}]};

    if (action.type==='MOVE') {
      // No deep-clone helper call anywhere in this function. `state`
      // (and therefore `p`, read from it) is a live immer draft --
      // structured cloning cannot walk a draft under any circumstances.
      // `action` itself is never drafted (runAction always hands it a
      // plain, already-copied value), so copying a field off it was
      // technically safe on its own -- but pack-lint's structural-sharing
      // check (packages/pack-linter/src/index.js) flags any deep-clone
      // style call inside applyActionInPlace's source, on purpose: it
      // cannot distinguish "safe because it's action data" from "unsafe
      // because it's state data" without real static analysis, so the
      // rule is simply "never do that here at all". A plain spread reads
      // through the draft's proxy traps correctly regardless of which
      // side the value came from, so it is the uniformly-safe choice.
      const from={...p.position}; const to={...action.target}; const tile=tileAt(s,to);
      p.position=to; p.fuel-=1; reveal(tile,action.actor);
      // getPlayerView() only ever shows an opponent's position/fuel to a
      // viewer once (position) or never (fuel, always owner-only) -- this
      // event used to broadcast both to every subscriber unconditionally,
      // silently reproducing exactly the information getPlayerView exists
      // to hide. Scoping it to the actor keeps the event useful for the
      // mover's own UI/animation; opponents who are entitled to see the
      // new position still get it correctly through their own per-viewer
      // `snapshot.state` on this same update, which is the real source of
      // truth here (see games/sector-expedition/src/game.js#getPlayerView).
      events.push({type:'PLAYER_MOVED',actor:action.actor,from,to,fuel:p.fuel,audience:[action.actor]});
      if (tile.object==='hazard') {
        p.hull=Math.max(0,p.hull-1);
        // hull is intentionally public in getPlayerView (never redacted for
        // opponents), so this event carries nothing that isn't already
        // visible to everyone -- no audience restriction needed.
        events.push({type:'HAZARD_TRIGGERED',actor:action.actor,hull:p.hull});
      } else if (tile.object==='beacon') {
        p.credits+=250; events.push({type:'BEACON_DISCOVERED',actor:action.actor,credits:p.credits,audience:[action.actor]});
      }
      if (rng && rng.int(1,100)<=EVENT_CHANCE_PERCENT) {
        const event = rng.int(0,1)===0 ? 'RADIO_BURST' : 'ION_STORM';
        if (event==='RADIO_BURST') { p.credits+=150; events.push({type:'RANDOM_EVENT',event,actor:action.actor,credits:p.credits,audience:[action.actor]}); }
        else { p.fuel=Math.max(0,p.fuel-1); events.push({type:'RANDOM_EVENT',event,actor:action.actor,fuel:p.fuel,audience:[action.actor]}); }
      }
      if (p.hull<=0) { s.phase='finished'; s.winner=other(Object.keys(s.players),action.actor); events.push({type:'GAME_FINISHED',winner:s.winner,reason:'HULL_ZERO'}); return {state:s,events}; }
    } else if (action.type==='SCAN') {
      const origin=p.position;
      const order=[...directions];
      if (rng) for (let i=order.length-1;i>0;i--){const j=rng.int(0,i);[order[i],order[j]]=[order[j],order[i]];}
      const chosen=order.slice(0,3); const opened=[];
      for (const d of chosen) {
        for (const distance of [1,2]) {
          const pos={q:origin.q+d.dq*distance,r:origin.r+d.dr*distance}; const tile=tileAt(s,pos);
          if (tile && !tile.revealedBy.includes(action.actor)) { reveal(tile,action.actor); opened.push(mapKey(pos.q,pos.r)); }
        }
      }
      p.scans+=1;
      // `opened` is exactly the fog-of-war information the scan mechanic
      // exists to gate -- must never go to the opponent.
      events.push({type:'SECTOR_SCANNED',actor:action.actor,opened,audience:[action.actor]});
    } else if (action.type==='SALVAGE') {
      const tile=tileAt(s,p.position);
      if (!Array.isArray(tile.collectedBy)) tile.collectedBy=[];
      if (tile.collectedBy.includes(action.actor)) return {accepted:false,error:{code:'SALVAGE_ALREADY_COLLECTED'},state:s,events:[]};
      tile.collectedBy.push(action.actor); p.salvage+=1; p.credits+=250;
      events.push({type:'SALVAGE_COLLECTED',actor:action.actor,total:p.salvage,credits:p.credits,audience:[action.actor]});
      if (p.salvage>=SALVAGE_GOAL && tile.object==='station') { /* unreachable after object cleared; return to station handled below */ }
    } else if (action.type==='BUY_FUEL') {
      p.credits-=FUEL_PACK_COST; p.fuel=Math.min(MAX_FUEL,p.fuel+3); events.push({type:'FUEL_PURCHASED',actor:action.actor,fuel:p.fuel,credits:p.credits,audience:[action.actor]});
    } else if (action.type==='END_TURN') {
      events.push({type:'TURN_ENDED',actor:action.actor});
    }

    // Victory: collect the target and return to the station.
    const atStation=tileAt(s,p.position)?.object==='station';
    if (p.salvage>=SALVAGE_GOAL && atStation) {
      s.phase='finished'; s.winner=action.actor; events.push({type:'GAME_FINISHED',winner:action.actor,reason:'SALVAGE_DELIVERED'}); return {state:s,events};
    }

    s.turn+=1;
    if (action.type==='END_TURN' || action.type!=='SCAN' && action.type!=='SALVAGE' && action.type!=='BUY_FUEL') {
      s.activePlayer=other(Object.keys(s.players),action.actor);
      if (s.activePlayer===action.actor || Object.keys(s.players).length===1) s.round+=1;
      if (s.players[s.activePlayer].fuel===0) {
        s.players[s.activePlayer].fuel=1;
        // Private to the player whose tank just got topped up -- fuel is
        // owner-only info per getPlayerView, same reasoning as everywhere
        // else in this file.
        events.push({type:'EMERGENCY_FUEL',actor:s.activePlayer,fuel:1,audience:[s.activePlayer]});
      }
      events.push({type:'TURN_CHANGED',activePlayer:s.activePlayer,round:s.round});
    }
    return {state:s,events};
  },

  getGameStatus(state) { return {finished:state.phase==='finished',winner:state.winner}; },

  getPlayerView(state, viewer) {
    const s=clone(state);
    // `seed` is server-private simulation input, never legitimate client
    // data: the client needs nothing from it, and this engine's RNG
    // derives its entire internal state deterministically and publicly
    // from this exact value (see packages/core/src/rng/SeededRng.js) --
    // leaking it is equivalent to leaking the RNG's internal state
    // outright, with zero brute-force required, regardless of how
    // resistant the generator itself is to state recovery from observed
    // outputs. Delete unconditionally, including for the seed's own
    // "owner" (no viewer legitimately needs it) and for spectators.
    delete s.seed;
    const viewerId=viewer ?? null;
    for (const tile of Object.values(s.map)) {
      const visible=viewerId==null || tile.revealedBy.includes(viewerId) || tile.object==='station';
      if (!visible) {
        tile.terrain='unknown';
        tile.object=null;
        delete tile.collectedBy;
      } else if (tile.object==='salvage' && viewerId!=null && tile.collectedBy?.includes(viewerId)) {
        tile.object='depleted';
        tile.collectedBy=[];
      } else {
        tile.collectedBy = Array.isArray(tile.collectedBy) ? [...tile.collectedBy] : [];
      }
      delete tile.revealedBy;
    }
    if (viewerId!=null) {
      for (const [id,p] of Object.entries(s.players)) {
        if (id!==viewerId) {
          const tile=state.map[mapKey(p.position.q,p.position.r)];
          const visible=tile?.revealedBy?.includes(viewerId);
          s.players[id]={id,position:visible?clone(p.position):null,hull:p.hull};
        }
      }
    }
    return s;
  },
};

export const sectorExpeditionConstants={SALVAGE_GOAL,FUEL_PACK_COST,MAX_HULL,MAX_FUEL};
