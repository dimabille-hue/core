# TABLETOP GAME ENGINE 1.40.111-R1
# Технический архитектурный аудит и refactor report

Дата: 2026-08-28  
Аудируемый базовый артефакт: `tabletop-engine-1.40.111-engine-only-with-launcher (1).zip`  
Результат: `tabletop-engine-1.40.111-refactored-r1-engine-only-with-launcher.zip`

---

## 1. Executive verdict

### Итог в одном абзаце

Полный rewrite движка не оправдан. Архитектурное направление проекта в целом правильное: engine/core, server, client, presentation и game packs уже разделены концептуально, поэтому выкидывать код и начинать с нуля было бы дорого и нерационально. Однако исходный runtime имел несколько **реальных архитектурных defects**, которые нельзя свести к стилю или субъективным предпочтениям: state и presentation events конкурировали за один retention buffer; event callbacks могли рекурсивно переполнять JS stack; async game rules могли продолжить mutation после завершения команды; card projection имел fail-open fallback, потенциально раскрывающий canonical state; server принимал произвольную player identity без криптографического binding; match creation и Pack Manager имели сетевые DoS/administrative exposure; public HTTP path позволял обращаться к произвольным файлам pack; pack update не был staged/atomic; distribution artifact не имел полностью воспроизводимого тестового контракта.

Поэтому правильное решение — **deep refactor execution kernel + hardening инфраструктурных boundary'ов**, а не rewrite всей системы.

### Оценка после R1

| Область | До R1 | После R1 | Комментарий |
|---|---:|---:|---|
| Разделение модулей | 7/10 | 8/10 | выделены context/state-view/event-dispatch/replay concerns |
| Simulation kernel | 5/10 | 6/10 | опасные runtime paths закрыты, но mutable state остаётся |
| Determinism | 6/10 | 7/10 | sync contract + расширенный hash + replay record |
| Event architecture | 4/10 | 7/10 | отдельные stream buffers + non-recursive dispatcher |
| Privacy | 4/10 | 6/10 | card projection теперь fail-closed; event audience всё ещё contract |
| Server/security | 3/10 | 6/10 | identity token, admin auth, match cap, upload limits |
| Pack lifecycle | 4/10 | 7/10 | staged update, hash-pinned cache, public-path allowlist |
| Reproducibility | 3/10 | 7/10 | distribution self-test теперь входит в archive |
| Maintainability | 5/10 | 6/10 | часть God Object decomposed, но kernel ещё большой |
| Production readiness | 3/10 | 6/10 | после R1 можно двигаться к pack certification; public deployment требует Phase 2 |

---

## 2. Scope и ограничения аудита

Аудит проводился не по полному developer repository, а по engine-only distribution archive плюс трем continuity/documentation files, которые были предоставлены рядом с архивом.

В engine-only archive отсутствуют исходные `test/`, `scripts/`, `examples/` и сами game-pack sources. Поэтому невозможно честно заявить, что все исторические project-wide tests были повторно запущены. Это было одной из причин, почему R1 включает **новый self-contained regression suite внутри distribution**.

Проверено:

- весь runtime JavaScript на синтаксическую корректность через `node --check`;
- существующая структура core/server/client/presentation/pack/launcher;
- критические execution paths;
- pack install/load/public-file paths;
- WebSocket handshake/frame validation;
- reproducible command replay;
- privacy projection;
- match identity binding;
- staged installation rollback;
- независимое удержание state/presentation event streams.

Важно: отсутствие game-pack source означает, что **game-pack certification ещё не выполнена**. В R1 добавлен migration/audit guide, чтобы следующий этап был системным.

---

## 3. Что было доказано в исходном коде

## 3.1. `game-engine.js` был execution God Object

Исходный `runtime/core/game-engine.js` совмещал state, players, turn order, command dispatch, decision/reaction flow, effects, scheduler, triggers, state-based rules, events, presentation events, projection, save/load, checkpoints, replay hash и lifecycle.

Проблема не в количестве строк как таковом. Проблема в том, что один объект одновременно являлся:

1. simulation state;
2. execution coordinator;
3. event dispatcher;
4. projection service;
5. persistence facade;
6. replay/hash facade;
7. player registry;
8. scheduler owner;
9. external capability bag.

В исходной модели `buildContext()` давал game pack один reusable context, внутри которого были доступны mutable state, players, random, knowledge, effects, scheduler, services и многочисленные mutators.

Это быстро писать. Это плохо масштабируется как контракт.

### Почему это опасно

Когда rule получает одновременно:

```text
state
players
knowledge
scheduler
emit
pushEffect
services
finish
setActive
setPhase
```

невозможно понять по сигнатуре callback, какая именно capability ему необходима. Следствие — скрытые зависимости и сложный review game packs.

### R1

Вынесены отдельные модули:

- `runtime/core/context.js` — сборка execution context;
- `runtime/core/state-view.js` — projection/snapshot/public pending/player view;
- `runtime/core/execution.js` — synchronous callback contract;
- `runtime/core/event-dispatcher.js` — dispatch semantics;
- `runtime/core/replay.js` — replay record/replay execution.

`game-engine.js` всё ещё остаётся большим. Это намеренно промежуточный refactor, а не искусственное разбиение по 20 строк. Следующий этап должен извлечь command pipeline, persistence и effect processing ещё глубже.

---

## 3.2. Mutable state и event log не образуют строгий source-of-truth

В engine game packs получают `ctx.state` как прямую ссылку.

Это значит, что правило может сделать:

```js
ctx.state.hp -= 10;
ctx.state.secret = true;
```

не эмитируя соответствующий domain event.

Поэтому исходная система фактически имела две параллельные истины:

```text
canonical mutable state
        +
optional event narrative
```

а не:

```text
command
  -> deterministic transition
  -> canonical state change
  -> canonical domain events
```

### Последствие

Нельзя гарантировать, что event log полностью реконструирует state.

Это влияет на:

- debugging;
- replay;
- audit;
- desync diagnosis;
- analytics;
- spectator reconstruction.

### Что сделано

R1 не ломает backward compatibility полным запретом direct mutation. Вместо этого зафиксирован explicit residual debt.

Новый replay format сохраняет command stream и execution metadata, а `replay()` способен воспроизвести его в свежем engine.

### Что остаётся сделать в Phase 2

Ввести controlled mutation boundary:

```text
Command
  -> Transaction
       -> controlled mutation
       -> domain events
       -> effects
       -> commit
```

Прямой `ctx.state` должен остаться только как read API либо быть заменён на `ctx.state.read()` / `ctx.mutate()`.

Это самый большой оставшийся архитектурный долг.

---

## 3.3. State и presentation events раньше делили один ring buffer

Это был реальный дефект, а не вкусовой вопрос.

Semantic contract проекта разделяет:

```text
STATE events
    synchronization / recovery

PRESENTATION events
    animation / FX / camera / TV noise
```

Но физически оба потока помещались в один ring buffer.

Тест:

```text
capacity = 32
40 STATE events
200 PRESENTATION events
```

показывал, что старые state events исчезают из-за presentation traffic.

Это создаёт зависимость:

```text
FX flood
  -> state event eviction
  -> event gap
  -> snapshot recovery
```

### R1 fix

`runtime/core/events.js` теперь хранит отдельные ring buffers:

```text
state stream      capacity N
presentation      capacity M
```

У каждого stream собственный `seq`, cursor и retention window.

Global event id сохраняется отдельно для diagnostic/ordering purposes.

Это уже не просто cleanup. Это исправление неправильной resource boundary.

---

## 3.4. Recursive event dispatch мог привести к stack overflow

В исходной модели `emit()` вызывал event hooks/triggers напрямую.

Конструкция:

```text
emit(A)
 -> onEvent(A)
    -> emit(A)
       -> onEvent(A)
          -> ...
```

может рекурсивно расти, пока Node не выдаст stack overflow.

Такое поведение особенно легко получить случайно при двух взаимных trigger rules.

### R1 fix

Добавлен `runtime/core/event-dispatcher.js`.

Теперь nested events сначала попадают в FIFO queue:

```text
emit(A)
  -> enqueue(A)
  -> dispatcher
       -> handler(A)
          -> emit(B)
             -> enqueue(B)
       -> handler(B)
```

JS call stack больше не растёт на каждое nested event.

Также существует `eventCascadeLimit`.

Default: `4096` событий на cascade boundary.

Если game pack создаёт безумную бесконечную event storm, engine останавливает cascade через явный error вместо неконтролируемого stack overflow.

---

## 3.5. Async callbacks раньше могли нарушить command boundary

Исходный `invoke()` просто вызывал пользовательский callback.

Проблема:

```js
async ctx => {
    await something();
    ctx.state.value = 99;
}
```

Command уже мог завершиться, revision increment уже мог произойти, response уже уйти клиенту — а Promise continuation продолжала менять canonical state.

Получается:

```text
command transaction ends
       ↓
revision committed
       ↓
Promise resumes
       ↓
state mutation outside command
```

Это принципиальный lifecycle violation.

### R1 policy

Engine теперь **формально synchronous**.

`runtime/core/execution.js` проверяет async functions до вызова.

Так callback вида:

```js
async function rule() {}
```

немедленно получает:

```text
async-callback-not-supported
```

И дополнительно проверяется thenable result для обычных функций.

Также под guard поставлены:

- `createState`;
- commands;
- triggers/effects callbacks;
- `availableActions`;
- `project`;
- dynamic player-count callbacks.

### Почему выбрана sync-модель

Для tabletop simulation это более простой и безопасный контракт.

Асинхронные операции можно реализовать через явный effect:

```text
simulation
  -> effect descriptor
  -> external executor
  -> next command/event
```

но не через произвольный `await` внутри deterministic rule.

---

## 3.6. Replay раньше был в основном hash helper

В исходном коде `replay.js` был прежде всего stable hash helper.

Hash полезен для desync detection, но сам по себе не является replay.

Настоящий replay должен содержать минимум:

```text
initial configuration
seed
players
commands
final verification
```

### R1

Добавлен:

```js
engine.exportReplay()
```

Формат содержит:

```text
formatVersion
engine

definition
seed
startOptions
players
commands
truncated
finalHash
```

Добавлена:

```js
replay(record, definition, createEngine)
```

которая создаёт новый engine, добавляет игроков, запускает игру, повторяет commands и сравнивает final hash.

### Важная оговорка

Replay command log ограничен `commandLogCapacity`.

Если log был truncation'd, `exportReplay()` специально запрещает выдачу «ложно полного» replay.

Для длинной production игры Phase 2 должна добавить checkpoint + segment model:

```text
checkpoint #0
commands 0..N
checkpoint #1
commands N..M
...
```

---

## 3.7. Card projection был fail-open

В `runtime/domains/cards/card-dsl.js` fallback projection мог включать весь state.

Для универсального hidden-information engine это опасно.

Безопасная модель должна быть:

```text
canonical state
      ↓
knowledge
      ↓
viewer projection
      ↓
client
```

а не:

```text
canonical state
      ↓
client
```

### R1

Fallback теперь fail-closed:

```text
snapshot only
```

Явный публичный state разрешается через:

```js
publicStatePaths: ['public.score', 'public.round']
```

Прежний небезопасный behaviour можно включить только явно через:

```js
legacyPublicState: true
```

Это сделано как миграционная опция, а не как default.

### Требование к game packs

Новый pack должен либо:

1. предоставлять явный `project()`;
2. для card DSL использовать `publicStatePaths`;
3. временно использовать `legacyPublicState`, но получить audit warning.

---

## 3.8. Match identity раньше была доверенной строкой

`MatchHost` принимал player identity из входящего JOIN сообщения.

По сути client мог сказать:

```text
id = attacker
```

и engine мог считать это player principal.

Это не authentication.

### R1

Добавлен `runtime/server/auth.js`:

- HMAC-SHA256 join tokens;
- match-scoped token;
- principal-scoped token;
- role-scoped token;
- expiry;
- timing-safe signature compare.

В production identity mode должен быть установлен:

```text
TABLETOP_REQUIRE_AUTH=1
TABLETOP_JOIN_SECRET=<secret>
```

или автоматически включается через `NODE_ENV=production`, если anonymous mode явно не разрешён.

### Ограничение

Это не полноценный identity provider.

Это admission/authentication primitive.

В production токен должен выпускаться:

```text
lobby/auth service
        ↓
join token
        ↓
engine MatchHost
```

---

## 3.9. Match creation раньше был потенциальным resource exhaustion vector

Unknown match id мог приводить к автоматическому созданию нового match.

А значит злоумышленнику достаточно генерировать random IDs.

### R1

Добавлены:

- `maxMatches`;
- `idleMatchTtlMs`;
- periodic prune;
- production default `TABLETOP_AUTO_CREATE_MATCHES=0` unless explicitly enabled.

Default cap:

```text
64 matches per MatchHost
```

Это не absolute security boundary, но теперь ресурс контролируем.

---

## 3.10. Pack Manager раньше был administrative surface без auth

HTTP API включал mutation endpoints:

```text
POST /api/packs/install
DELETE /api/packs/<id>
POST /api/packs/scan
```

без обязательной admin authentication.

### R1

Mutation операции требуют:

```text
X-Tabletop-Admin-Token
```

или explicit trusted-localhost mode:

```text
TABLETOP_PACK_MANAGER_ALLOW_LOCALHOST=1
```

Для production рекомендуется только explicit admin token/upstream authentication.

GET `/api/packs/scan` больше не является mutation/read-through alias.

---

## 3.11. Upload body раньше буферизовался без собственного limit

Даже при безопасном ZIP parser можно было сначала загрузить огромный multipart body в RAM, а только потом начать archive validation.

### R1

`launcher/server.js` имеет stream-level body limit:

```text
TABLETOP_PACK_UPLOAD_MAX
```

Default:

```text
20 MiB
```

Проверяется и `Content-Length`, и фактическое накопление body.

---

## 3.12. Pack replacement раньше не был staged/atomic

Опасная последовательность выглядит так:

```text
old pack
   ↓
replace/remove
   ↓
load new pack
   ↓
discover signature/manifest error
```

После ошибки можно потерять последнюю рабочую версию.

### R1

`PackManager.install()` делает:

```text
validate archive
 ↓
signature verification
 ↓
stage temp archive
 ↓
move old target to backup
 ↓
atomic move new target
 ↓
refresh/load verification
 ↓
commit
```

При ошибке:

```text
remove new target
restore backup
```

То есть последняя валидная версия сохраняется.

---

## 3.13. Pack cache теперь hash-aware

Раньше изменение pack archive можно было определить недостаточно строго по metadata.

R1 использует SHA-256 исходного archive в cache identity:

```text
<gameId>@<version>~<sha256-prefix>
```

Это уменьшает шанс stale cache и одновременно делает provenance видимой.

---

## 3.14. Public file access раньше был слишком широким

Launcher route `/games/:gameId/*` фактически обращался к pack path напрямую.

Если pack содержит:

```text
server.js
internal.json
source.js
secrets
```

то public server route не должен иметь к ним доступ.

### R1

Разрешены только:

```text
preview/
player-ui/
tv-ui/
assets/
public/
```

либо явно объявленные в manifest:

```json
"publicPaths": ["player-ui/", "assets/", "preview/"]
```

Попытка открыть `server.js` теперь получает `pack-file-not-public`.

---

## 3.15. Same-process pack execution остаётся trusted-code model

R1 **не делает вид**, что Ed25519 превращает JavaScript в sandbox.

Подписанный pack получает тот же Node process, если используется current in-process loader.

То есть:

```text
signature = provenance/integrity
NOT sandbox
```

Для truly untrusted third-party packs нужен отдельный process/container boundary.

Это сохраняется как explicit Phase 2 requirement.

---

## 3.16. WebSocket parser получил hard limits

R1 добавил/укрепил:

- handshake size limit;
- HTTP upgrade header validation;
- WebSocket version check;
- path length limit;
- frame size limit;
- masked-frame requirement;
- control-frame validation;
- 64-bit length overflow guard;
- messages-per-second limit;
- outbound high-water mark;
- корректный onClose cleanup.

Это не заменяет полноценный reverse proxy/WAF/rate-limit layer, но убирает несколько очевидных parser/abuse failure modes.

---

## 3.17. Distribution artifact раньше не был self-contained test contract

Root `package.json` вызывал historical project test scripts, которых нет в engine-only archive.

Поэтому установленный archive не мог доказать сам себя.

### R1

`package.json` теперь содержит:

```text
npm test
npm run test:refactor
npm run test:server
npm start
```

`npm test` запускает встроенный:

```text
test/refactor-hardening.cjs
```

Который проверяет critical invariants.

---

## 4. Что было сделано в коде

### Изменённые/новые файлы

```text
runtime/core/events.js
runtime/core/event-dispatcher.js          NEW
runtime/core/execution.js                NEW
runtime/core/context.js                  NEW
runtime/core/state-view.js               NEW
runtime/core/game-engine.js
runtime/core/replay.js
runtime/domains/cards/card-dsl.js
runtime/pack-host.js
runtime/pack-manager.js
runtime/zip-reader.js
runtime/server/auth.js                   NEW
runtime/server/match-host.js
runtime/server/websocket.js
runtime/host-server.js
launcher/server.js
launcher/public/pack-manager.html
runtime/index.js
package.json
test/refactor-hardening.cjs              NEW
```

### Архитектурный эффект

До:

```text
                 createEngine()
                      |
        +-------------+---------------+
        |             |               |
      state          events        projection
        |             |               |
        +------ effects/scheduler ---+
        |             |               |
        +------ network/server ------+
```

После R1:

```text
                   Simulation Kernel
                         |
             +-----------+-----------+
             |                       |
        command lifecycle         state view
             |                       |
      +------+-------+          +----+------+
      |              |          |           |
   effects        dispatcher  snapshot   projection
      |              |          |
 scheduler       State stream   privacy
                 Presentation

Infrastructure boundary
------------------------
Pack Manager / Host / HTTP / WS / Auth / Client / Launcher
```

Это пока не конечная архитектура, но dependency direction стала заметно жёстче.

---

## 5. Новые runtime invariants

R1 вводит следующие обязательства.

### I1 — Game rules are synchronous

Нельзя:

```js
async function rule() {}
```

и нельзя возвращать Promise из обычного callback.

### I2 — State and presentation retention are independent

Presentation traffic не имеет права вытеснять authoritative state events.

### I3 — Event cascades are iterative

Nested event emit проходит через FIFO dispatcher.

### I4 — Public card projection is fail-closed

Canonical state не публикуется generic fallback'ом.

### I5 — Production match identity is cryptographically scoped

Identity привязан к match + principal + role + expiry.

### I6 — Production Pack Manager is authenticated

Mutation endpoints не должны быть anonymous.

### I7 — Pack installation is staged

Новая версия не может уничтожить последнюю рабочую версию, пока новая версия не прошла validation/load gate.

### I8 — Pack public assets are allowlisted

Server-side code не должен автоматически становиться HTTP asset.

### I9 — Distribution proves itself

`npm test` должен работать непосредственно в distributed engine archive.

---

## 6. Что осталось и почему это ещё не Phase 2-complete

R1 сознательно не пытался одновременно провести breaking rewrite всего engine.

Оставшиеся проблемы:

### P2.1 — Mutable `ctx.state`

Это главный residual architectural debt.

Нужен controlled mutation API.

### P2.2 — `atomic` не откатывает external side effects

Checkpoint rollback касается engine memory state, но не:

```text
filesystem
DB
HTTP
external service
metrics side effects
```

Правильный путь — effect descriptors + post-commit execution.

### P2.3 — In-process game packs не sandboxed

Нужен process/container isolation для untrusted packs.

### P2.4 — Native auth token ≠ complete identity system

Нужен pluggable `IdentityProvider`.

### P2.5 — Replay needs checkpoints for long sessions

Command log cap недостаточен для очень длинной игры.

### P2.6 — Event audience is still partly game-pack responsibility

`emit(type,payload,audience)` позволяет неправильному pack author указать неправильную audience policy.

Следующий вариант должен уметь делать:

```text
CanonicalEvent
    ↓
AudienceProjection
    ↓
ViewerEvent
```

### P2.7 — `game-engine.js` ещё не достаточно мал

Следующие кандидаты на extraction:

```text
command-pipeline.js
effect-runtime.js
persistence.js
player-registry.js
```

Но это нужно делать без фиктивных wrappers. Каждое выделение должно владеть реальным invariant.

---

## 7. Что НЕ нужно делать

### Не нужно переводить engine на ECS только потому, что Bevy использует ECS

Tabletop simulation не требует обязательного ECS. ECS полезен как execution/data-oriented pattern, но это не proof that this engine should adopt it.

### Не нужно делать realtime rollback/prediction stack

Для turn-based/tabletop проекта authoritative server + deterministic commands — достаточная основа.

### Не нужно переписывать renderer/client из-за core defects

Основная проблема была в simulation/security boundaries, а не в Player/TV rendering.

### Не нужно писать собственную криптографию

Нынешний HMAC/Ed25519 путь использует Node crypto primitives.

---

## 8. Почему сравнение с GitHub-проектами полезно

### boardgame.io

boardgame.io формулирует turn-based game logic как функции изменения game state, а multiplayer flow отделяет client от authoritative game master. В документации отдельно описаны state management, logs/time travel, phases и multiplayer, а core reducer централизует state transition и log semantics. Это хороший ориентир для усиления transaction/state-transition boundary в нашем engine.

Links:

- Repository: https://github.com/boardgameio/boardgame.io
- Reducer: https://github.com/boardgameio/boardgame.io/blob/main/src/core/reducer.ts
- Multiplayer: https://github.com/boardgameio/boardgame.io/blob/main/docs/documentation/multiplayer.md

### Bevy

Bevy демонстрирует value явных systems/resources/schedules и слабой связанности частей runtime. Для нашего проекта это полезно не как призыв внедрять ECS, а как доказательство важности явных execution boundaries и scheduling semantics.

Links:

- ECS guide: https://github.com/bevyengine/bevy/blob/main/examples/ecs/ecs_guide.rs
- Repository: https://github.com/bevyengine/bevy

### Godot

Godot описывает low-level servers как слой, поверх которого может существовать scene system. Это полезный architectural precedent для нашего разделения simulation/infrastructure/presentation: optional UI/presentation не должен определять simulation core.

Links:

- Server architecture: https://github.com/godotengine/godot-docs/blob/master/tutorials/performance/using_servers.rst
- Architecture docs: https://github.com/godotengine/godot-docs

### openage

openage документирует отдельные subsystems: simulation, rendering/presenter, networking, time management и scripting, с явно описанным information flow. Это близко к целевому направлению нашего engine: подсистемы должны быть optional и общаться через boundary interfaces.

Link:

- Architecture: https://github.com/SFTtech/openage/blob/master/doc/code/architecture.md

### Gaffer

Gaffer показывает, почему deterministic command-based simulation привлекательна для networked games, и одновременно предупреждает, насколько трудно обеспечить настоящую determinism. Для нашего engine это аргумент в пользу строгого synchronous deterministic command contract, а не произвольного async rule execution.

Links:

- Networking: https://github.com/mas-bandwidth/gafferongames/blob/main/content/post/what_every_programmer_needs_to_know_about_game_networking.md

---

## 9. Game-pack migration and audit policy

Полный guide находится в:

`GAME_PACK_REFACTOR_GUIDE_1.40.111_R1.md`

Ключевая идея:

```text
Game Pack = pure rules module + public surfaces + manifest
```

а не:

```text
Game Pack = arbitrary Node application copied into engine
```

### Минимальная структура

```text
manifest.json
server.js
preview/index.html
player-ui/index.html        # if player capability
player-ui/*.js
player-ui/*.css
tv-ui/index.html             # if tv capability
tv-ui/*.js
tv-ui/*.css
assets/*
README.md
```

`server.js` никогда не должен считаться public asset.

### Правила

1. Rule callbacks synchronous.
2. RNG только через engine `ctx.random`.
3. Не использовать `Math.random()` для simulation decisions.
4. Не использовать `Date.now()` как game-state input.
5. Не использовать uncontrolled external I/O inside command callbacks.
6. Все hidden information проходит через projection/knowledge.
7. Presentation event не должен кодировать authoritative state transition.
8. Trigger loops должны иметь конечную семантику.
9. Pack должен быть replayable.
10. Save/load должен сохранять deterministic continuation.
11. Public assets должны быть allowlisted.
12. Third-party pack должен быть подписан перед production install.

---

## 10. Pack audit checklist

The distribution now includes a non-executing first-pass auditor:

```bash
npm run audit:pack -- ./path/to/game-pack.zip
```

The tool checks the manifest, required surfaces, engine compatibility and common deterministic/security smells in server/domain code. It is deliberately a **screening tool**, not a certification: it does not prove gameplay correctness, privacy correctness or sandbox safety.

## 10. Pack audit checklist

Каждый pack перед certification должен получить verdict по категориям:

### A. Contract

- manifest valid;
- engineCompatibility valid;
- capability flags match actual surfaces;
- publicPaths explicit;
- entry exports valid definition.

### B. Determinism

- same seed + same commands = same state;
- no wall clock in rules;
- no external random source;
- no async callback;
- stable serialization.

### C. State

- every authoritative mutation intentional;
- no secret data in player projection;
- no UI object stored in canonical state;
- no circular state object that breaks clone/save/replay.

### D. Events

- state event vs presentation event classification;
- audience explicit;
- event storm bounded;
- no recursive self-trigger;
- no sensitive payload on public event.

### E. Effects

- external I/O explicit;
- idempotency defined;
- retry semantics defined;
- no hidden filesystem/network access.

### F. UI

- Player receives only player-visible model;
- TV receives only public model;
- preview does not run authoritative command path;
- UI does not mutate engine state directly.

### G. Multiplayer

- player identity bound;
- reconnect deterministic;
- duplicate CID safe;
- event cursor recovery tested;
- snapshot fallback tested.

### H. Performance

- no O(N^2) trigger scans on hot turn path;
- no full state clone per cosmetic presentation event;
- no unbounded arrays;
- no excessive DOM redraw;
- no unnecessary full snapshot transport.

---

## 11. Recommended game-pack migration order

Do not refactor all packs simultaneously.

Recommended sequence:

```text
1. choose one simple pack
2. make it R1-clean
3. certify replay/determinism/privacy
4. use it as golden pack
5. migrate card-heavy pack
6. migrate hidden-information pack
7. migrate spatial/high-churn pack
8. only then freeze pack API
```

The first golden pack should be the one with the smallest rules surface, not the flagship game.

---

## 12. Release and operations configuration

Important production variables:

| Variable | Purpose | Recommended production posture |
|---|---|---|
| `TABLETOP_PACK_SECURITY` | pack verification mode | `signature` |
| `TABLETOP_ALLOW_UNSIGNED_PACKS` | dev bypass | unset |
| `TABLETOP_ADMIN_TOKEN` | Pack Manager mutation auth | required |
| `TABLETOP_PACK_MANAGER_ALLOW_LOCALHOST` | local admin bypass | unset in production |
| `TABLETOP_PACK_UPLOAD_MAX` | multipart request cap | 20 MiB or lower as needed |
| `TABLETOP_ZIP_MAX_ARCHIVE` | archive size cap | 60 MiB default |
| `TABLETOP_ZIP_MAX_ENTRIES` | archive entry count cap | existing default |
| `TABLETOP_ZIP_MAX_FILE` | individual uncompressed file cap | existing default |
| `TABLETOP_ZIP_MAX_UNCOMPRESSED` | total decompressed cap | existing default |
| `TABLETOP_REQUIRE_AUTH` | force join auth | `1` |
| `TABLETOP_JOIN_SECRET` | HMAC join secret | strong random secret |
| `TABLETOP_ALLOW_ANONYMOUS` | auth bypass | unset |
| `TABLETOP_MAX_MATCHES_PER_GAME` | resource cap | sized to host |
| `TABLETOP_MATCH_IDLE_TTL_MS` | cleanup idle matches | set for public server |
| `TABLETOP_AUTO_CREATE_MATCHES` | arbitrary match creation | `0` |
| `TABLETOP_HTTP_HOST` | launcher bind | prefer loopback/reverse-proxy or controlled LAN bind |
| `TABLETOP_PRUNE_INTERVAL_MS` | prune cadence | 30s default |

---

## 13. Verification performed on R1

### Syntax

All JavaScript in `runtime/` and `launcher/` was checked with:

```bash
find runtime launcher -type f \( -name '*.js' -o -name '*.cjs' \) -print0 \
  | xargs -0 -n1 node --check
```

### Regression suite

```bash
npm test
```

Expected/current result:

```text
ok - state and presentation streams do not evict each other
ok - event cascades do not consume the JS call stack
ok - async rule callbacks are rejected
ok - initialization and projection callbacks cannot escape the sync boundary
ok - exported replay reproduces the authoritative state
ok - card DSL does not expose canonical state by default
ok - pack manager keeps the current pack when replacement validation fails
ok - match host binds identity when authentication is required
ok - join tokens are scoped and time-bound
refactor-hardening: PASS
```

### Additional checks

- `runtime/index.js` exports `createEngine`, `EventLog`, `replay`;
- WebSocket module parses after hardening;
- launcher no longer exposes GET `/api/packs/scan` as a public alias;
- pack `server.js` is not an HTTP public file;
- installed pack survives invalid replacement attempt;
- new pack version is used by new matches after pack refresh;
- command replay refuses truncated logs instead of returning a misleading record.

---

## 14. Recommended Phase 2 architecture

Final target:

```text
                 +----------------------+
                 |     Match Host       |
                 +----------+-----------+
                            |
                     Command Admission
                            |
                 +----------v-----------+
                 |   Simulation Kernel   |
                 |-----------------------|
                 | Command Pipeline      |
                 | State Store           |
                 | Effect Runtime        |
                 | Event Dispatcher      |
                 | Scheduler             |
                 +----+-------------+----+
                      |             |
               Domain Events      Effects
                      |             |
              +-------v--+      +--v----------------+
              | Event Log |      | External Executor |
              +----+------+      +-------------------+
                   |
          +--------+---------+
          |                  |
   Viewer Projection   Replay/Checkpoint
          |
    +-----+-----+
    |           |
 Player       TV/Observer

Infrastructure:
----------------
Pack Host / Pack Manager / Auth / WebSocket / HTTP / Launcher
```

Ключевой принцип:

> **Simulation Kernel не должен знать, как WebSocket или HTML работает.**

А Pack Manager не должен знать semantic internals simulation.

---

## 15. Финальная рекомендация

### Статус R1

**Recommended to adopt as new engine baseline.**

### Но не считать engine final

Следующие изменения следует считать обязательными перед массовым подключением сторонних game packs:

1. controlled state mutation;
2. effect/side-effect boundary;
3. process/container sandbox for untrusted packs;
4. pluggable identity provider;
5. canonical viewer-event projection;
6. replay checkpoints;
7. resource budgets per match;
8. дальнейшее уменьшение `game-engine.js`.

### Что теперь можно делать

Можно начинать **поштучный audit и migration game packs** на R1 contract.

Нельзя пока честно заявлять:

> «Любой произвольный third-party game pack безопасен». 

R1 закрывает множество инфраструктурных failure modes, но in-process CommonJS pack остаётся trusted code.

---

## 16. Conclusion

Главное изменение мышления после аудита должно быть таким:

Не измерять качество engine числом модулей или строк.

Измерять его тем, **какие invariants engine способен гарантировать автоматически**.

Исходный проект уже имел хорошие идеи. R1 превращает часть этих идей в реальные runtime constraints:

```text
sync callbacks
independent event streams
iterative event dispatch
fail-closed projection
authenticated admission
bounded server resources
staged pack install
public path allowlist
self-tested distribution
```

Это достаточно серьёзный архитектурный шаг, чтобы использовать R1 как baseline для следующего цикла.

---

## 17. External engineering references

- boardgame.io repository: https://github.com/boardgameio/boardgame.io
- boardgame.io reducer: https://github.com/boardgameio/boardgame.io/blob/main/src/core/reducer.ts
- boardgame.io multiplayer: https://github.com/boardgameio/boardgame.io/blob/main/docs/documentation/multiplayer.md
- Bevy ECS guide: https://github.com/bevyengine/bevy/blob/main/examples/ecs/ecs_guide.rs
- Godot server architecture: https://github.com/godotengine/godot-docs/blob/master/tutorials/performance/using_servers.rst
- openage architecture: https://github.com/SFTtech/openage/blob/master/doc/code/architecture.md
- Gaffer game networking: https://github.com/mas-bandwidth/gafferongames/blob/main/content/post/what_every_programmer_needs_to_know_about_game_networking.md

Все GitHub references сверены 2026-08-28. Они используются как architectural references, а не как копирование чужого дизайна один-в-один.
