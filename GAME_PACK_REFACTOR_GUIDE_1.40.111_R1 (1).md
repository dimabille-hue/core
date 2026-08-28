# GAME PACK REFACTOR / MIGRATION GUIDE — 1.40.111-R1

Этот документ нужен как handoff для следующего этапа: **аудит и оптимизация самих game packs**.

Важно: текущий engine-only distribution не содержит исходников game packs. Поэтому этот guide задаёт новый контракт и audit procedure; он не является сертификатом конкретной игры.

---

## 1. Новая модель Game Pack

Рекомендуемая ментальная модель:

```text
Game Pack
├── manifest.json
├── server.js              # trusted simulation definition
├── preview/               # public
├── player-ui/             # public
├── tv-ui/                 # public
├── assets/                # public
├── README.md
└── tests/                 # developer/source distribution, optional in runtime ZIP
```

`server.js` не является web asset.

Pack не должен содержать launcher logic, websocket server logic или собственный HTTP server.

---

## 2. Manifest

Минимальная форма:

```json
{
  "schemaVersion": 1,
  "packFormatVersion": 1,
  "gameId": "example-game",
  "name": "Example Game",
  "version": "1.0.0",
  "entry": "server.js",
  "engineCompatibility": "1.40.x",
  "capabilities": ["player", "tv"],
  "publicPaths": [
    "preview/",
    "player-ui/",
    "tv-ui/",
    "assets/"
  ]
}
```

`publicPaths` рекомендуется объявлять явно. Если поле отсутствует, R1 использует безопасный default allowlist:

```text
preview/
player-ui/
tv-ui/
assets/
public/
```

---

## 3. Server definition

`server.js` должен экспортировать definition:

```js
module.exports = {
  id: 'example-game',

  createState() {
    return {
      round: 1,
      score: {},
    };
  },

  project(state, viewer, snapshot, extra) {
    return {
      ...snapshot,
      public: {
        round: state.round,
      },
    };
  },

  actions: {
    END_TURN(ctx) {
      ctx.state.round += 1;
    },
  },
};
```

Это только compatibility shape текущего API. В Phase 2 state mutation должен быть заменён на controlled transaction API.

---

## 4. Synchronous-only rule contract

Нельзя:

```js
actions: {
  BUY: async ctx => {
    await fetch(...);
    ctx.state.gold -= 5;
  }
}
```

и нельзя:

```js
function BUY(ctx) {
  return Promise.resolve(...);
}
```

R1 отвергает async callback до его исполнения.

### Что делать вместо этого

Вынести external operation в effect descriptor:

```js
BUY(ctx) {
  // deterministic state transition
  ctx.state.gold -= 5;
  ctx.pushEffect({
    type: 'PUBLISH_BUY_RESULT',
    payload: { player: ctx.actor }
  });
}
```

А actual external I/O делать за simulation boundary.

---

## 5. Determinism rules

В authoritative rule code запрещено полагаться на:

```text
Math.random()
Date.now()
new Date()
process.hrtime()
network response ordering
filesystem ordering
implicit locale ordering
```

Используйте:

```js
ctx.random
ctx.now()
engine state
explicit command input
```

`ctx.now()` в R1 представляет deterministic simulation time (`command`, `turn`), а не wall clock.

---

## 6. State design

Canonical state должен содержать только simulation-relevant data.

Не хранить там:

```text
DOM nodes
browser objects
WebSocket instances
functions
Promises
large caches
network clients
file handles
```

Хороший canonical state:

```js
{
  round: 7,
  currentPlayer: 'p2',
  board: [...],
  hands: {
    p1: [...],
    p2: [...]
  }
}
```

Плохой canonical state:

```js
{
  ui: document.body,
  socket,
  fetchPromise,
  cachedRenderedCards
}
```

---

## 7. Hidden information / privacy

### Главное правило

Никогда не считать:

```js
project(state, viewer) => ({ ...state })
```

допустимым для hidden-information game.

### Рекомендуемая схема

```text
Canonical State
      |
      +--> KnowledgeStore(viewer)
      |
      v
 Viewer Projection
      |
      +--> Player
      +--> TV
```

Пример:

```js
project(state, viewer, snapshot, extra) {
  const hand = extra.knowledge?.hand || [];

  return {
    ...snapshot,
    hand,
    publicBoard: state.board,
    score: state.score,
  };
}
```

TV projection должна быть отдельной веткой, а не случайным reuse player projection.

---

## 8. Card DSL migration

### Старый опасный default

Если pack зависел от старого поведения `composeCardDefinition()`, где public state мог автоматически включаться целиком, это необходимо удалить.

### Новый безопасный default

```js
composeCardDefinition(base, cards)
```

без дополнительных настроек возвращает snapshot без canonical state.

### Предпочтительный migration

```js
composeCardDefinition(base, cards, {
  publicStatePaths: [
    'round',
    'score',
    'boardPublic'
  ]
})
```

Если нужно явно сложное view:

```js
const definition = composeCardDefinition(base, cards);
definition.project = (state, viewer, snapshot, extra) => ({
  ...snapshot,
  board: state.board,
  hand: extra.knowledge?.hand || []
});
```

### Временный compatibility escape

```js
legacyPublicState: true
```

может использоваться только с открытым migration issue.

Не считать его certification-compatible.

---

## 9. Events

Разделяйте:

```text
state event
presentation event
```

### State event

Меняет/описывает authoritative simulation:

```text
PLAYER_DAMAGED
CARD_DRAWN
TURN_STARTED
ZONE_CAPTURED
```

### Presentation event

Только UI semantics:

```text
CAMERA_SHAKE
CARD_FLIP
PLAY_SFX
SHOW_BANNER
```

### Запрещённая практика

Не передавать в presentation event весь canonical state.

---

## 10. Event audiences

Используйте явную audience policy:

```text
PUBLIC
PLAYER:p1
PLAYER:p2
TV
SERVER
```

Но не считайте audience string достаточной privacy defense.

Для hidden-information pack рекомендуется:

```text
Canonical Event
   ↓
viewer-specific projection
   ↓
transport event
```

То есть event payload itself не должен содержать секрет, если его потом предполагается broadcast'ить.

---

## 11. Trigger discipline

Каждый trigger должен отвечать на вопрос:

> «Может ли этот trigger привести снова к себе?»

Если да — нужен конечный budget.

Пример опасного pattern:

```js
onEvent(ctx, event) {
  if (event.type === 'A') {
    ctx.emit('A');
  }
}
```

R1 dispatcher не даёт этой конструкции съесть JS stack, но pack всё равно должен быть исправлен: cascade limit — safety net, а не normal execution semantics.

---

## 12. Effects

External effects должны быть declarative where possible:

```js
ctx.pushEffect({
  type: 'SEND_NOTIFICATION',
  payload: {...}
});
```

Не:

```js
ctx.services.http.post(...)
ctx.services.fs.writeFileSync(...)
```

в середине authoritative transition.

### Причина

Checkpoint rollback не может откатить внешний I/O.

---

## 13. Player lifecycle

Проверить:

```text
onPlayerJoin
onPlayerLeave
onPlayerUpdate
onConnectionChange
eliminate
revive
ready
```

Каждый lifecycle hook должен быть:

- synchronous;
- deterministic;
- replay-safe;
- independent of browser/UI objects.

---

## 14. Turn/phase design

Turn/phase transitions должны быть выражены через engine primitives:

```js
ctx.endTurn()
ctx.setPhase('combat')
ctx.setActive('p2')
```

Не держать parallel hidden turn state inside pack:

```js
let currentPlayer = 0;
```

если engine уже владеет authoritative turn order.

Иначе возникают два source-of-truth:

```text
engine.meta.active
pack.currentPlayer
```

---

## 15. Replay certification

Для каждого pack создать golden scenario:

```text
seed: 12345
players: p1,p2
commands:
  1. DRAW
  2. PLAY_CARD
  3. END_TURN
  4. REACT
  5. END_TURN
```

Проверять:

```text
run A final hash
run B final hash
```

должны быть равны.

Затем:

```text
exportReplay()
↓
replay()
↓
finalHash match
```

---

## 16. Save/load certification

Golden save должен сохраняться в середине сложного момента:

```text
pending decision
pending reaction
scheduled effect
partially resolved stack
hidden information
```

После load:

```text
snapshot same
knowledge same
rng continuation same
next command result same
```

Особенно тестировать:

- scheduler;
- effect stack;
- pending decisions;
- pending reactions;
- rule latch.

---

## 17. Performance audit

Для каждого pack снять хотя бы:

```text
median command time
p95 command time
p99 command time
snapshot time
projection time
event count per command
effect count per command
state serialized size
snapshot serialized size
```

Сначала оптимизировать:

```text
O(N^2) rule scans
unnecessary full snapshots
repeated cloning
repeated projection
unbounded trigger queues
```

Не начинать с premature Worker/ECS/WASM rewrite.

---

## 18. Public asset audit

Убедиться, что pack не ожидает:

```text
/games/id/server.js
/games/id/internal.js
/games/id/test.js
```

Public pack URL должен быть построен из:

```text
preview/
player-ui/
tv-ui/
assets/
public/
```

Если нужен другой каталог — добавить explicit `publicPaths`.

---

## 18.5 Automated first-pass audit

Run from the engine distribution root:

```bash
npm run audit:pack -- ./game-pack.zip
```

The scanner does not execute the pack. It reports `PASS`, `PASS WITH WARNINGS` or `BLOCKED` and catches common smells such as async rules, `Math.random()`, wall-clock reads, direct Node I/O and missing public surfaces. Treat the output as a screening gate before the deeper manual/gameplay audit.

## 19. Pack Manager audit

Перед install проверять:

```text
manifest valid
engine compatible
signature valid
entry exists
preview exists
player surface exists when declared
tv surface exists when declared
publicPaths valid
zip limits respected
```

После install:

```text
host.refresh()
host.get(gameId)
host.load(gameId)
```

должны работать.

---

## 20. Versioning policy

Новый pack должен иметь semver-like version.

Match должен быть логически pinned to:

```text
gameId
packVersion
archiveHash
```

Правило:

```text
existing match => old immutable definition
new match      => newest installed definition
```

Нельзя тихо менять rules of an active match.

---

## 21. Signing policy

После любого изменения:

```text
server.js
manifest.json
publicPaths
player-ui
assets
```

pack необходимо re-sign.

Signature — это integrity/provenance boundary.

Она не делает pack sandboxed.

---

## 22. Golden migration workflow

Рекомендуемый процесс на каждую игру:

```text
A. inventory
B. classify state
C. classify events
D. classify hidden data
E. remove async callbacks
F. remove wall-clock randomness
G. add projection
H. add replay scenario
I. add save/load scenario
J. add multiplayer reconnect scenario
K. add performance baseline
L. sign pack
M. certify
```

---

## 23. Certification verdicts

Каждый pack должен получить один из verdicts:

```text
PASS
PASS WITH WARNINGS
BLOCKED
```

### BLOCKED examples

- secret state visible to player/TV;
- async authoritative rule;
- nondeterministic RNG;
- uncontrolled external I/O;
- incompatible manifest;
- invalid signature in production;
- player identity assumptions outside engine auth;
- impossible save/load continuation;
- infinite event cascade.

### PASS WITH WARNINGS

- legacyPublicState temporary use;
- large snapshot;
- high event volume but bounded;
- performance p95 acceptable but needs optimization;
- legacy UI route still present.

---

## 24. First migration target

Выберите **самый простой** pack, чтобы создать golden example.

После его успешной миграции используйте его структуру как template для остальных.

Не начинайте с самого сложного hidden-information game.

---

## 25. Suggested source tree for future audited packs

```text
pack/
├── manifest.json
├── server.js
├── domain/
│   ├── rules.js
│   ├── projections.js
│   ├── setup.js
│   └── effects.js
├── preview/
│   └── index.html
├── player-ui/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── tv-ui/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── assets/
└── README.md
```

Даже если пока runtime loader требует один `server.js`, внутреннюю domain organization стоит сделать такой.

---

## 26. Final rule for pack authors

Если правило невозможно объяснить как:

```text
input command
+ deterministic state
+ deterministic RNG
→ state transition
+ canonical events
+ declarative effects
```

то оно заслуживает architecture review до попадания в production pack.

---

## 27. Final checklist before sign-off

```text
[ ] npm test passes against R1 engine
[ ] pack manifest validates
[ ] production signature validates
[ ] no async callbacks
[ ] no Math.random in rules
[ ] no wall clock in rules
[ ] projection reviewed for each viewer
[ ] TV projection reviewed separately
[ ] event audiences reviewed
[ ] trigger loops bounded
[ ] save/load tested
[ ] exportReplay/replay tested
[ ] reconnect tested
[ ] large-state case benchmarked
[ ] publicPaths reviewed
[ ] server.js not publicly reachable
[ ] active-match version pinning understood
```
