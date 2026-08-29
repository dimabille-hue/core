const DIR = { N:[0,-1], S:[0,1], E:[1,0], W:[-1,0] };
const inside = (p) => p.x >= 0 && p.x < 5 && p.y >= 0 && p.y < 5;
const other = (id) => id === 'A' ? 'B' : 'A';
export const gridDuel = {
  version: 'grid-duel@1',
  createInitialState() { return { turn:0, activePlayer:'A', phase:'playing', winner:null, players:{ A:{id:'A',hp:3,position:{x:0,y:0}}, B:{id:'B',hp:3,position:{x:4,y:4}} } }; },
  getLegalActions(state, actor) { if (state.phase !== 'playing' || actor !== state.activePlayer) return []; return [{type:'MOVE'}, {type:'ATTACK'}]; },
  applyAction(state, action) { return this.applyActionInPlace(structuredClone(state), action); },
  applyActionInPlace(state, action) {
    const s = state; const actor = s.players[action.actor]; const events=[];
    if (action.type === 'MOVE') {
      const d = DIR[action.direction]; if (!d) return { state:s, events:[{type:'ACTION_REJECTED',code:'INVALID_DIRECTION'}] };
      const to={x:actor.position.x+d[0],y:actor.position.y+d[1]};
      if (!inside(to)) return { state:s, events:[{type:'ACTION_REJECTED',code:'OUT_OF_BOUNDS'}] };
      if (Object.values(s.players).some(p=>p.id!==actor.id&&p.position.x===to.x&&p.position.y===to.y)) return { state:s, events:[{type:'ACTION_REJECTED',code:'OCCUPIED'}] };
      const from=actor.position; actor.position=to; events.push({type:'PLAYER_MOVED',actor:action.actor,from,to});
    } else if (action.type === 'ATTACK') {
      const target=s.players[other(action.actor)]; const dist=Math.abs(actor.position.x-target.position.x)+Math.abs(actor.position.y-target.position.y);
      if (dist!==1) return { state:s, events:[{type:'ACTION_REJECTED',code:'TARGET_NOT_ADJACENT'}] };
      target.hp--; events.push({type:'PLAYER_ATTACKED',actor:action.actor,target:target.id,damage:1});
      if (target.hp<=0) { s.phase='finished'; s.winner=action.actor; events.push({type:'GAME_FINISHED',winner:action.actor}); return {state:s,events}; }
    }
    s.turn++; s.activePlayer=other(action.actor); events.push({type:'TURN_CHANGED',activePlayer:s.activePlayer}); return {state:s,events};
  },
  getGameStatus(state) { return { finished:state.phase==='finished', winner:state.winner }; }
};
