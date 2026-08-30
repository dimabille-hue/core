import { PlayerClient } from '/client/browser/player-client.js';
import { ClientRuntime } from '/client/browser/runtime.js';
import { FrameScheduler } from '/client/browser/frame-scheduler.js';
import { reduceLastSectorEvent } from '../client-state.mjs';
import { createAssetIcon, assetName } from '../assets.mjs';

const q = new URLSearchParams(location.search);
const match = q.get('match') || 'demo';
const player = q.get('player') || 'p1';
const wsUrl = q.get('ws') || `ws://${location.hostname || 'localhost'}:8080`;
const socketConnect = () => new Promise((resolve, reject) => {
  const s = new WebSocket(wsUrl);
  s.onopen = () => resolve(s);
  s.onerror = reject;
});
const client = new PlayerClient({ connect: socketConnect, match, principal: player });
const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
const $ = id => document.getElementById(id);
const status = $('status');
const grid = $('grid');
const events = $('events');
const buttons = $('buttons');
const cellRefs = new Map();
let selectedAction = null;
let renderedActionKey = '';

const renderScheduler = new FrameScheduler(() => {
  render();
  buildButtons();
});

function setStatus(v) {
  const labels = { connecting:'ПОДКЛЮЧЕНИЕ…', 'transport-connected':'СОЕДИНЕНИЕ УСТАНОВЛЕНО', 'session-ready':'ГОТОВ', connected:'ПОДКЛЮЧЕНО', resumed:'ПЕРЕПОДКЛЮЧЕНО', disconnected:'СВЯЗЬ ПОТЕРЯНА', 'connect-error':'ОШИБКА СОЕДИНЕНИЯ', stopped:'ОСТАНОВЛЕНО' };
  status.textContent = labels[v] || String(v).toUpperCase();
  status.className = v === 'connected' || v === 'resumed' || v === 'session-ready' ? 'status-ok' : 'status-bad';
}

let autoReadySent = false;
runtime.on('state', state => {
  setStatus(state);
  const qs = new URLSearchParams(location.search);
  if (qs.get('deviceTest') === '1' && qs.get('autoReady') === '1' && !autoReadySent && (state === 'session-ready' || state === 'resumed')) {
    autoReadySent = true;
    runtime.ready(true);
    queueLog('device-test: ready');
  }
});
runtime.on('error', e => queueLog(`error: ${e.code || e.message || 'unknown'}`));
runtime.on('snapshot', () => renderScheduler.schedule());
runtime.on('events', (list, msg) => {
  queueLogs(list, msg?.stream);
  if (msg?.stream === 'state') renderScheduler.schedule();
});

function ensureGrid(state) {
  if (cellRefs.size || !Array.isArray(state?.tiles)) return;
  const frag = document.createDocumentFragment();
  for (const cell of state.tiles) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.coord = cell.coord;
    const object = document.createElement('div');
    object.className = 'cell-object';
    object.hidden = true;
    const unit = document.createElement('div');
    unit.className = 'unit';
    unit.hidden = true;
    el.append(object, unit);
    cellRefs.set(cell.coord, { el, object, unit, kind: undefined, objectKind: undefined, unitKey: undefined, title: undefined });
    frag.appendChild(el);
  }
  grid.replaceChildren(frag);
}

function render() {
  const snap = runtime.snapshot;
  const state = snap?.state;
  if (!state) return;
  ensureGrid(state);

  $('player').textContent = player;
  const own = state.units?.find(u => u.owner === player && u.status !== 'destroyed');
  if (own) {
    $('ship-type').textContent = own.shipType.toUpperCase();
    $('ship-hp').textContent = `${own.hp}/${own.maxHp} HP`;
    $('hp-readout').textContent = `${own.hp}/${own.maxHp}`;
    $('fuel-readout').textContent = `${own.fuel}`;
    $('move-readout').textContent = `${own.moves}`;
    $('hp-bar').style.width = `${Math.max(0, Math.min(100, own.hp / Math.max(1, own.maxHp) * 100))}%`;
    $('fuel-bar').style.width = `${Math.max(0, Math.min(100, own.fuel / Math.max(1, own.maxFuel ?? 10) * 100))}%`;
    $('move-bar').style.width = `${Math.max(0, Math.min(100, own.moves / Math.max(1, own.movePoints ?? 4) * 100))}%`;
    $('score').textContent = snap.scores?.[player] ?? state.scores?.[player] ?? 0;
    $('cargo').textContent = (own.cargo || []).length;
  }
  $('turn').textContent = `Active: ${snap.active || '—'}`;
  updateMobileStatus(own);

  const units = new Map((state.units || [])
    .filter(u => u.status !== 'destroyed')
    .map(u => [u.coord, u]));

  for (const cell of state.tiles || []) {
    const ref = cellRefs.get(cell.coord);
    if (!ref) continue;
    const kind = cell.kind || 'hidden';
    if (ref.kind !== kind) {
      ref.kind = kind;
      ref.el.className = `cell${kind === 'hidden' ? ' hidden' : ''}`;
      ref.el.dataset.kind = kind;
      const visibleObject = kind !== 'hidden' && kind !== 'empty' && kind !== 'center';
      if (!visibleObject) {
        ref.object.hidden = true;
        ref.objectKind = undefined;
      } else if (ref.objectKind !== kind) {
        ref.objectKind = kind;
        ref.object.replaceChildren(createAssetIcon(document, assetName(kind), { className: 'ls-asset' }));
        ref.object.hidden = false;
      } else {
        ref.object.hidden = false;
      }
    }

    const u = units.get(cell.coord);
    if (!u) {
      if (!ref.unit.hidden) ref.unit.hidden = true;
      ref.unitKey = undefined;
      delete ref.el.dataset.moveTarget;
      continue;
    }

    const key = `${u.owner}|${u.shipType}|${u.status}`;
    if (ref.unitKey !== key) {
      ref.unitKey = key;
      ref.unit.hidden = false;
      ref.unit.dataset.ship = u.shipType || '';
      ref.unit.replaceChildren(createAssetIcon(document, assetName(u.shipType), { className: 'ls-asset' }));
      ref.unit.classList.toggle('own', u.owner === player);
      ref.unit.classList.toggle('other', u.owner !== player);
      ref.unit.dataset.owner = u.owner === player ? 'self' : 'other';
      ref.unit.title = u.owner === player ? 'Ваш корабль' : `Корабль игрока ${u.owner}`;
    } else if (ref.unit.hidden) {
      ref.unit.hidden = false;
    }
    if (selectedAction === 'MOVE' && kind !== 'hidden') ref.el.dataset.moveTarget = '1';
    else delete ref.el.dataset.moveTarget;
    const title = u.owner === player
      ? `${({scout:'РАЗВЕДЧИК',transport:'ТРАНСПОРТ',warship:'БОЕВОЙ КОРАБЛЬ',tanker:'ТАНКЕР'}[u.shipType]||u.shipType).toUpperCase()} • ${u.hp}/${u.maxHp} прочности • ${u.fuel} топлива`
      : `Игрок ${u.owner} • ${u.shipType} • позиция ${u.coord}`;
    if (ref.title !== title) {
      ref.title = title;
      ref.unit.title = title;
    }
  }
}

const EVENT_NAMES = Object.freeze({
  SECTOR_GENERATED:'Сектор создан', SHIP_MOVED:'Корабль перемещён', TELEPORTED:'Телепорт', FORCED_MOVE:'Принудительное перемещение',
  PLAYER_SHIP_DESTROYED:'Корабль уничтожен', CARGO_DELIVERED:'Груз доставлен', SIGNAL_GOOD:'Сигнал принят', TRAP_PLACED:'Ловушка установлена',
  TURN_STARTED:'Начало хода', DISCOVERY_REVEALED:'Обнаружено', LOOT_FOUND:'Найден ресурс', BATTLE_RESOLVED:'Бой завершён', GREAT_STORM:'Великий шторм'
});
const ACTIONS = Object.freeze({
  MOVE:['i-move','Движение'], ATTACK:['i-attack','Атака'], ATTACK_TANKER:['i-attack','Атака танкера'],
  SCAN:['i-scan','Сканирование'], COLLECT:['i-collect','Сбор'], TELEPORT:['i-teleport','Телепорт'],
  REPAIR:['i-repair','Ремонт'], BUY_FUEL:['i-fuel','Купить топливо'], BUY_TRAP:['i-trap','Установить ловушку'], END_TURN:['i-end','Конец хода']
});
function actionButton(action, mobile=false) {
  const meta=ACTIONS[action]||['i-info',action.replaceAll('_',' ').toLowerCase()];
  const b=document.createElement('button'); b.type='button'; b.className='action-button'; b.dataset.action=action;
  b.setAttribute('aria-label',meta[1]); b.title=meta[1];
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use'); use.setAttribute('href',`./icons.svg#${meta[0]}`); svg.appendChild(use);
  const label=document.createElement('span'); label.className='action-label'; label.textContent=meta[1]; b.append(svg,label);
  if(action==='MOVE') b.addEventListener('click',()=>{selectedAction='MOVE'; renderScheduler.schedule();});
  else b.addEventListener('click',()=>runtime.command({type:action}));
  return b;
}
function buildButtons() {
  const actions=runtime.snapshot?.availableActions||[]; const key=actions.join('|'); if(renderedActionKey===key)return; renderedActionKey=key;
  const frag=document.createDocumentFragment(); const mfrag=document.createDocumentFragment();
  for(const action of actions){frag.appendChild(actionButton(action));mfrag.appendChild(actionButton(action,true));}
  buttons.replaceChildren(frag); $('mobile-actions').replaceChildren(mfrag);
}
function updateMobileStatus(own) {
  if(!own)return;
  $('m-hp').textContent=`${own.hp}`; $('m-fuel').textContent=`${own.fuel}`; $('m-moves').textContent=`${own.moves}`;
  $('m-turn').textContent=(runtime.snapshot?.active||'—').toString().slice(0,4).toUpperCase();
}
function openMobileInfo(){
  const sheet=$('mobile-sheet'); const own=runtime.snapshot?.state?.units?.find(u=>u.owner===player&&u.status!=='destroyed');
  sheet.replaceChildren();
  const title=document.createElement('div'); title.className='sheet-title'; title.textContent=own?'СОСТОЯНИЕ КОРАБЛЯ':'КОРАБЛЬ'; sheet.append(title);
  if(!own){const empty=document.createElement('div'); empty.className='sheet-value'; empty.textContent='Активный корабль отсутствует'; sheet.append(empty); sheet.hidden=false; return;}
  const type=document.createElement('div'); type.className='sheet-value'; type.textContent=(({scout:'РАЗВЕДЧИК',transport:'ТРАНСПОРТ',warship:'БОЕВОЙ КОРАБЛЬ',tanker:'ТАНКЕР'}[own.shipType]||own.shipType||'').toUpperCase()); sheet.append(type);
  const rows=[['КОРПУС',`${own.hp}/${own.maxHp}`],['ТОПЛИВО',String(own.fuel)],['ОД',String(own.moves)],['ГРУЗ',String((own.cargo||[]).length)],['ОЧКИ',String(runtime.snapshot?.scores?.[player]??runtime.snapshot?.state?.scores?.[player]??0)]];
  for(const [k,v] of rows){const row=document.createElement('div'); row.className='sheet-row'; const l=document.createElement('span'); l.textContent=k; const b=document.createElement('b'); b.textContent=v; row.append(l,b); sheet.append(row);}
  sheet.hidden=!sheet.hidden;
}
$('mobile-info')?.addEventListener('click',openMobileInfo);
document.addEventListener('click', event => { const sheet=$('mobile-sheet'); if (!sheet || sheet.hidden) return; if (event.target.closest?.('#mobile-sheet') || event.target.closest?.('#mobile-info') || event.target.closest?.('#mobile-menu')) return; sheet.hidden=true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { const sheet=$('mobile-sheet'); if (sheet) sheet.hidden=true; } });
$('mobile-menu')?.addEventListener('click',()=>{
  const sheet=$('mobile-sheet');
  const actions=runtime.snapshot?.availableActions||[];
  sheet.hidden=false;
  sheet.replaceChildren(); const title=document.createElement('div'); title.className='sheet-title'; title.textContent='ТАКТИЧЕСКОЕ УПРАВЛЕНИЕ'; sheet.append(title);
  const value=document.createElement('div'); value.className='sheet-value'; value.textContent=actions.length ? actions.map(a=>String(a).replaceAll('_',' ')).join(' · ') : 'Доступных действий нет'; sheet.append(value);
  const row=document.createElement('div'); row.className='sheet-row'; const l=document.createElement('span'); l.textContent='СОЕДИНЕНИЕ'; const b=document.createElement('b'); b.textContent=status.textContent; row.append(l,b); sheet.append(row);
});

grid.addEventListener('click', event => {
  if (selectedAction !== 'MOVE') return;
  const cell = event.target.closest?.('.cell');
  if (!cell || cell.dataset.moveTarget !== '1') return;
  runtime.command({ type: 'MOVE', to: cell.dataset.coord });
  selectedAction = null;
  renderScheduler.schedule();
});

const logQueue = [];
let logScheduled = false;
function queueLogs(list, stream) {
  for (const e of list || []) logQueue.push(`${stream === 'presentation' ? 'ВИЗУАЛ' : 'СОСТОЯНИЕ'}: ${EVENT_NAMES[e.type] || String(e.type).replaceAll('_',' ')}`);
  scheduleLogFlush();
}
function queueLog(text) { logQueue.push(text); scheduleLogFlush(); }
function scheduleLogFlush() {
  if (logScheduled) return;
  logScheduled = true;
  queueMicrotask(flushLogs);
}
function flushLogs() {
  logScheduled = false;
  if (!logQueue.length) return;
  const frag = document.createDocumentFragment();
  while (logQueue.length) {
    const e = document.createElement('div');
    e.className = 'event';
    e.textContent = `${new Date().toLocaleTimeString()} · ${logQueue.shift()}`;
    frag.appendChild(e);
  }
  events.prepend(frag);
  while (events.children.length > 40) events.lastElementChild.remove();
}

buildButtons();
runtime.start();
window.addEventListener('beforeunload', () => { renderScheduler.cancelPending(); client.stop(); });
