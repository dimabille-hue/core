import { TvClient } from '/client/browser/tv-client.js';
import { ClientRuntime } from '/client/browser/runtime.js';
import { FrameScheduler } from '/presentation/browser/frame-scheduler.js';
import { PresentationDispatcher } from '/presentation/browser/dispatcher.js';
import { FxRuntime } from '/presentation/browser/fx-runtime.js';
import { PresentationSequenceRuntime } from '/presentation/browser/sequence-runtime.js';
import { createLastSectorPresentation } from '../presentation.mjs';
import { reduceLastSectorEvent } from '../client-state.mjs';
import { createAssetIcon, assetName } from '../assets.mjs';
import { OnboardingRuntime } from '/client/browser/onboarding-runtime.js';
import { PresentationCamera } from '/presentation/browser/camera.js';
import { LastSectorTutorialDemo } from '../tutorial.mjs';

const q = new URLSearchParams(location.search);
const match = q.get('match') || 'demo';
const wsUrl = q.get('ws') || `ws://${location.hostname || 'localhost'}:8080`;
const socketConnect = () => new Promise((resolve, reject) => {
  const s = new WebSocket(wsUrl);
  s.onopen = () => resolve(s);
  s.onerror = reject;
});
const client = new TvClient({ connect: socketConnect, match, principal: 'tv' });
const onboarding = new OnboardingRuntime({ client, viewer: 'tv' });
const runtime = new ClientRuntime(client, { stateReducer: reduceLastSectorEvent });
const presentation = createLastSectorPresentation();
const dispatcher = new PresentationDispatcher(presentation);
const fxLayer = document.getElementById('fx-layer');
const fxRuntime = new FxRuntime(fxLayer, { maxActive: 20 });
const sequenceRuntime = new PresentationSequenceRuntime({ fxRuntime, maxConcurrent: 4 });
const mapViewport = $('map-viewport');
const mapWorld = $('map-world');
const camera = new PresentationCamera({ viewport: mapViewport, content: mapWorld, maxScale: 1.32 });
const tutorialDemo = new LastSectorTutorialDemo($('tutorial-scene'), { camera });
const $ = id => document.getElementById(id);
const tutorial = { root: $('tutorial'), title: $('tutorial-title'), body: $('tutorial-body'), step: $('tutorial-step'), progress: $('tutorial-progress'), focus: $('tutorial-focus') };
let tutorialTimer = null;
let tutorialPlan = null;
let tutorialIndex = 0;
function clearTutorialTimer(){ if(tutorialTimer){ clearTimeout(tutorialTimer); tutorialTimer=null; } }
function finishTutorial(skip=false){ clearTutorialTimer(); if(tutorial?.root) tutorial.root.hidden=true; tutorialDemo.clear(); camera.reset({duration:420}); onboarding.complete({skip}); }
function showTutorialStep(){
  if(!tutorialPlan || !tutorialPlan.steps?.length || tutorialIndex>=tutorialPlan.steps.length){ finishTutorial(false); return; }
  const step=tutorialPlan.steps[tutorialIndex]; tutorial.title.textContent=step.title; tutorial.body.textContent=step.body; tutorial.step.textContent=`${tutorialIndex+1} / ${tutorialPlan.steps.length}`; tutorial.progress.style.width=`${((tutorialIndex+1)/tutorialPlan.steps.length)*100}%`; tutorial.focus.textContent=step.focus?step.focus.toUpperCase():'';
  tutorial.root.hidden=false;
  tutorialDemo.play(step);
  clearTutorialTimer();
  tutorialTimer=setTimeout(()=>{tutorialIndex++;showTutorialStep();}, Math.max(1500, step.durationMs||4000));
}
onboarding.on(plan=>{ tutorialPlan=plan; if(plan?.status==='playing'){ tutorialIndex=0; showTutorialStep(); } });
document.getElementById('tutorial-skip')?.addEventListener('click',()=>finishTutorial(true));
window.addEventListener('keydown', e=>{ if(!tutorialPlan || tutorial.root.hidden) return; if(e.key==='Escape' || e.key==='s'){ e.preventDefault(); finishTutorial(true); } });

const feed = $('feed');
const grid = $('grid');
const cellRefs = new Map();
const renderScheduler = new FrameScheduler(() => render());

const operatorList=$('operator-list');
let renderedPlayersKey='';
let routeTimer=null;
function highlightRoute(coords=[]){
  for(const ref of cellRefs.values()) ref.el.classList.remove('route-active','route-end');
  const list=(Array.isArray(coords)?coords:[]).filter(Boolean);
  list.forEach((coord,i)=>{const ref=cellRefs.get(coord);if(ref){ref.el.classList.add('route-active');if(i===list.length-1)ref.el.classList.add('route-end');}});
  if(routeTimer) clearTimeout(routeTimer);
  routeTimer=setTimeout(()=>{for(const ref of cellRefs.values()) ref.el.classList.remove('route-active','route-end');routeTimer=null;},800);
}
function renderPlayers(players){
  const key=(players||[]).map(p=>`${p.id}|${p.eliminated}|${p.connected}|${p.shipType||''}`).join(';');
  if(key===renderedPlayersKey) return; renderedPlayersKey=key;
  const colors=['cyan','blue','red','violet']; const frag=document.createDocumentFragment();
  for(const [i,p] of (players||[]).entries()){
    const el=document.createElement('div'); el.className=`operator ${colors[i%colors.length]}`;
    const label=(p.name||p.id||'?').slice(0,8).toUpperCase();
    const icon=document.createElement('span'); icon.className='op-icon'; icon.appendChild(createAssetIcon(document, assetName(p.shipType), { className:'ls-asset' }));
    const info=document.createElement('div');
    const name=document.createElement('b'); name.textContent=label;
    const state=document.createElement('small'); state.textContent=p.eliminated?'ВЫВЕДЕН':p.connected===false?'НЕ В СЕТИ':'АКТИВЕН';
    info.append(name,state); el.append(icon,info); frag.appendChild(el);
  }
  operatorList.replaceChildren(frag);
}

const logQueue = [];
let logScheduled = false;

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
  const state = snap?.state || snap;
  if (!state) return;
  ensureGrid(state);
  renderPlayers(snap.players);
  const units = new Map((state.units || [])
    .filter(x => x.status !== 'destroyed')
    .map(x => [x.coord, x]));
  for (const cell of state.tiles || []) {
    const ref = cellRefs.get(cell.coord);
    if (!ref) continue;
    const kind = cell.kind || 'hidden';
    if (ref.kind !== kind) {
      ref.kind = kind;
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
      continue;
    }
    const key = `${u.owner}|${u.shipType}|${u.status}`;
    if (ref.unitKey !== key) {
      ref.unitKey = key;
      ref.unit.hidden = false;
      ref.unit.dataset.ship = u.shipType || '';
      ref.unit.replaceChildren(createAssetIcon(document, assetName(u.shipType), { className: 'ls-asset' }));
      ref.unit.classList.toggle('other', true);
    } else if (ref.unit.hidden) {
      ref.unit.hidden = false;
    }
    const title = `${u.owner} • ${u.shipType} • ${u.coord}`;
    if (ref.title !== title) {
      ref.title = title;
      ref.unit.title = title;
    }
  }
}

runtime.on('state', s => { $('status').textContent = s.toUpperCase(); });
runtime.on('snapshot', () => renderScheduler.schedule());
function resolvePoint(value) {
  const coord = typeof value === 'string' ? value : value?.coord || value?.id;
  if (!coord) return { x: 50, y: 50 };
  const ref = cellRefs.get(coord);
  if (!ref) return { x: 50, y: 50 };
  const a = ref.el.getBoundingClientRect();
  const b = fxLayer.getBoundingClientRect();
  return { x: ((a.left + a.width / 2 - b.left) / Math.max(1, b.width)) * 100, y: ((a.top + a.height / 2 - b.top) / Math.max(1, b.height)) * 100 };
}

runtime.on('events', (events, msg) => {
  if (msg?.stream === 'presentation') {
    const eventsWithoutSequences = [];
    for (const event of events || []) {
      const alias = presentation.sequenceAliases?.[event.type];
      const factory = presentation.sequences?.[event.type] || (alias ? presentation.sequences?.[alias] : null);
      if (factory) {
        const sequence = factory ? factory(event, { resolvePoint, camera }) : null;
        if (event.type==='ROUTE_HIGHLIGHT') highlightRoute(event.payload?.path);
      if (sequence) sequenceRuntime.play(sequence);
      } else {
        eventsWithoutSequences.push(event);
      }
    }
    const descriptors = dispatcher.dispatch(eventsWithoutSequences, { resolvePoint, camera });
    for (const descriptor of descriptors) {
      if (descriptor) fxRuntime.play(descriptor);
    }
    const last = descriptors.at(-1);
    if (last) flash('ВИЗУАЛЬНОЕ СОБЫТИЕ');
  }
  queueLogs(events, msg?.stream);
  if (msg?.stream === 'state') renderScheduler.schedule();
});

function flash(text) {
  $('event-title').textContent = text.replaceAll('.', ' ').replaceAll('_', ' ').toUpperCase();
  $('event-sub').textContent = 'СОБЫТИЕ В ИГРЕ';
  const el = $('event-title');
  requestAnimationFrame(() => {
    el.classList.remove('flash');
    requestAnimationFrame(() => el.classList.add('flash'));
  });
}
function queueLogs(events, stream) {
  for (const e of events || []) logQueue.push(`${stream || 'state'}: ${e.type}`);
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
    e.textContent = logQueue.shift();
    frag.appendChild(e);
  }
  feed.prepend(frag);
  while (feed.children.length > 8) feed.lastElementChild.remove();
}

runtime.start();
window.addEventListener('beforeunload', clearTutorialTimer);
window.addEventListener('beforeunload', () => { renderScheduler.cancelPending(); sequenceRuntime.clear(); fxRuntime.clear(); tutorialDemo.clear(); camera.destroy(); client.stop(); if(routeTimer) clearTimeout(routeTimer); });
