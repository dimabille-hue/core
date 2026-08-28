# Жёсткий независимый аудит: Tabletop Engine 1.40.111-R1

Аудитор: внешний ревью (не автор R1-рефактора). Смотрел исходники, а не только `TECHNICAL_AUDIT_1.40.111_R1.md`, который лежит в архиве — это self-report предыдущего прогона, я его использую как *контекст*, а не как источник истины.

Референсы, заданные в ТЗ, и что я реально с ними сверял:
- **boardgame.io** — `state transitions`, server authority, event/log model
- **Bevy ECS** — явные системы/ресурсы vs god-context
- **Godot servers** — отделение runtime от presentation
- **openage** — разделение sim/render/net/time/scripting
- **Gaffer networking** — детерминизм и границы command-модели

---

## 0. Вердикт

Архитектурная линия (core / server / client / presentation / domains / packs) — правильная, это не игрушечный монолит. Но в текущем состоянии движок **не готов принимать недоверенные game packs и не готов к продакшену с реальными деньгами/рейтингом**, по одной причине, которая перевешивает всё остальное: **приватность информации (закрытые руки, закрытые зоны) не является инвариантом ядра — это договорённость с автором пака**, которую ничто не проверяет во время выполнения. Для карточного движка это не второстепенный баг, это провал основного контракта жанра.

Второе по значимости: **`dispatch()` не атомарен по умолчанию** (`options.atomic !== true`), из-за чего исключение посреди экшена оставляет `state` в частично изменённом виде без отката. Для движка, который продаёт себя через deterministic replay и hash — это прямое противоречие собственной рекламируемой гарантии.

Остальное — важные, но не фатальные находки уровня hardening.

---

## 1. P0 — Критично, блокирует прод

### 1.1. Приватная информация в картах — opt-in, а не enforced (это главная находка)

`runtime/domains/cards/card-table.js:46`:
```js
hand(player) {
  assert(this.ctx.players.has(player), 'unknown-player');
  const z = this.state.hands[player] ||= [];
  return new Zone(`hand:${player}`, { id: `hand:${player}`, cards: z }, ...);
}
```
Рука игрока лежит прямо в `ctx.state.hands[player]` — обычном enumerable-поле общего mutable `state`. Это тот самый объект, который `state-view.js` передаёт **целиком** в `definition.project(state, viewer, base, ctx)`:

```js
// state-view.js
const projected = assertSyncResult(definitionProject(state, viewer, base, {...}), 'PROJECT');
return clone(projected);
```

Если автор game pack просто делает `project: (state) => ({...base, ...state})` (естественный первый вариант, который напишет 90% разработчиков, копирующих `templates/game-pack-r1/server.js`, где `project()` — трёхстрочный ручной whitelisting без какого-либо намёка на карты/руки), — **все руки всех игроков уходят каждому клиенту**, включая зрителей. Никакого fail-closed на этом пути нет — фактически fail-**open**, потому что дефолт для нового объекта — "всё видно", а не "всё скрыто".

При этом в движке *есть* правильный примитив — `ZoneManager.visible(id, viewer)` (в `zone-manager.js`), который честно фильтрует по `visibility: 'owner'|'hidden'`. Но:
1. `CardTable.hand()` (более "боевой", используемый в карточных пакетах путь) **вообще не проходит через этот фильтр**, отдаёт `Zone`, поверх которой все методы (`cards`, `toJSON()`) читают state как есть.
2. Ни один из двух примитивов не подключён к `project()` автоматически. Kernel про них не знает вообще — `state-view.js` и `game-engine.js` ничего не импортируют из `domains/cards`.

Единственная защита — статический линтер `tools/audit-game-pack.cjs`:
```js
if (manifest.capabilities?.includes('player') || manifest.capabilities?.includes('tv')) {
  if (!serverText.includes('project')) warnings.push('no-explicit-project-function-detected');
}
```
Это (а) **warning, не finding** — не блокирует verdict `BLOCKED`; (б) банальный `String.includes('project')` — пройдёт даже если `project` упомянут в комментарии или используется неправильно; (в) этот аудит вообще не обязателен — `pack-host.js#load()` его не вызывает, это отдельный CLI, который никто не обязан запускать перед `npm run install-pack`.

**Почему это критично именно для карточного движка**: скрытая информация — это не UX-фича, это часть правил игры (можно выиграть партию, просто открыв devtools → Network → SNAPSHOT и почитав JSON). В отличие от boardgame.io, где `playerView` — центральная, документированная, обязательная концепция фреймворка с готовыми хелперами (`PlayerView.STRIP_SECRETS`) именно для этого сценария, здесь это "impl detail", который каждый автор пака обязан переизобрести правильно, без единого guardrail.

**Что делать:**
- Ядро должно уметь **отказывать в старте матча**, если `definition.project` не задекларировал явную visibility-политику для известных карточных зон (например, через обязательный `definition.visibility` реестр политик из `visibility.js` policies, а не произвольный projection).
- `state-view.js` должен уметь взять список зон из `state.zones`/`state.hands` (если domain cards используется) и **по умолчанию скрывать** всё, что не помечено `public`, если игра явно не предоставила projection для конкретного поля — т.е. **fail-closed на уровне поля, а не только на уровне «забыли project вообще»**.
- `tools/audit-game-pack.cjs` "no-explicit-project-function-detected" обязан быть **finding**, а не warning, когда capability включает `player`; плюс нужен рантайм self-test в CI пака: сгенерировать снапшот для viewer A и проверить, что в нём отсутствуют байты card-id из `state.hands[B]` — grep по сериализованному JSON вместо доверия к тому, что автор написал правильный код.
- Задокументировать в `GAME_PACK_REFACTOR_GUIDE` конкретный, тестируемый паттерн для карточных игр — сейчас единственный референс-шаблон (`templates/game-pack-r1/server.js`) не карточный и ничему не учит по части зон.

### 1.2. `dispatch()` не атомарен по умолчанию → детерминированная, но необратимая порча state

`game-engine.js:299`:
```js
const checkpoint = atomic ? makeCheckpoint() : null;
...
try {
  const result = invoke(actor, command.type, action, command);
  ...
} catch (error) {
  if (checkpoint) restoreCheckpoint(checkpoint);
  throw normalizeError(error);
}
```
`atomic` берётся из `options.atomic === true` — **по умолчанию `false`**. Значит любой экшен вида "списать ресурс → применить эффект → бросить исключение на невалидной цели" (типичный код в реальных карточных правилах: "заплати 2 маны, затем выбери цель, `assert(target-valid)`") оставляет ресурс списанным, а эффект — не применённым. Это не крэшит движок и не ломает детерминизм replay (то же самое произойдёт при повторном воспроизведении тех же команд), но это ломает **саму игру** — состояние на столе больше не соответствует ни одному валидному игровому состоянию, что не восстановить откатом одного хода.

Собственный `TECHNICAL_AUDIT` (P2.2) упоминает, что atomic не откатывает *внешние* side effects — это верно, но не покрывает более базовую проблему: **atomic вообще не включён по умолчанию для внутреннего state**, а это единственное, что реально важно для 99% карточных игр без внешних side effects внутри правил.

**Что делать:** атомарность checkpoint/restore должна быть **дефолтом**, а не opt-in флагом (`clone()` через `structuredClone` — не настолько дорогая операция, чтобы жертвовать корректностью state по умолчанию; opt-*out* для перформанс-критичных случаев — нормальная модель, opt-*in* для корректности — нет).

### 1.3. In-process untrusted execution: подпись — не песочница, но движок ведёт себя так, будто это почти песочница

`PACK_SECURITY.md` сам честно пишет: *"Cryptographic signing is a provenance/integrity boundary, not a JavaScript sandbox... the in-process engine deliberately does not pretend to sandbox CommonJS game rules."* Это правильная формулировка, я с ней согласен. Но дальше по стеку это признание **никак не отражено в реальной изоляции процесса**:

`pack-host.js:94`:
```js
const mod = require(path.resolve(r.root, r.entry));
```
Обычный `require()` игрового пака **в том же процессе**, что WebSocket-сервер, `MatchHost`, `PackManager` с admin-эндпоинтами и файловой системой хоста. Подписанный (или, с `TABLETOP_ALLOW_UNSIGNED_PACKS=1`, вообще неподписанный в dev) пак получает полный доступ к Node.js API: `fs`, `child_process`, сетевые сокеты, `process.env` (включая `TABLETOP_ADMIN_TOKEN`, если он в env). Статический анализ (`audit-game-pack.cjs`) ловит `require('fs')` grep-ом по тексту — обходится тривиально (`require('f'+'s')`, динамический `require(atob(...))`, `import()` вместо `require`).

Это ровно то, о чём предупреждает Godot/openage дизайн (разделение subsystem boundaries) и почему у Bevy системы получают **явно объявленные** ресурсы, а не произвольный доступ ко всему рантайму: здесь пак получает не "объявленный набор capability", а буквально весь process. `definition.services` в `context.js` — хорошая идея (явный whitelisted bag capability), но она не обязательна и ничего не мешает паку сделать `require('node:fs')` напрямую в своём модуле в обход `ctx.services`.

**Что делать (то, что уже написано в PACK_SECURITY.md, но не сделано в коде):** реальная OS/process-изоляция для untrusted паков — `worker_threads` с ограниченным `vm` контекстом как минимум, полноценный child process/container с сокращёнными правами — как рекомендуется в вашем же файле. Пока этого нет, "signed pack" должно означать **first-party pack**, и в документации/UI лаунчера обязана быть явная формулировка "third-party packs run with full server privileges", а не молчаливое доверие подписи.

### 1.4. Голый TLS-less WebSocket-сервер, слушающий `0.0.0.0` по умолчанию, без Origin-проверки

`websocket.js` — самописный HTTP-Upgrade/WS-фрейминг поверх `node:net`. Технически он неплохо сделан (маска обязательна, `rsv` проверяется, `maxFrameSize`/`maxHandshakeSize`/`maxMessagesPerSecond` есть, фрагментация запрещена — окей выбор для простоты). Но:
- Никакого TLS вообще (`net.createServer`, не `tls.createServer`). `host-server.js` слушает `DEVICE_HOST || '0.0.0.0'` по умолчанию.
- Нет проверки `Origin`-заголовка на handshake — при деплое без reverse proxy это классическая CSWSH (cross-site WebSocket hijacking) поверхность, особенно с учётом того, что `requireIdentity` по умолчанию выключен вне `NODE_ENV=production` (`match-host.js:11`), т.е. **анонимный join разрешён по умолчанию в dev/staging**, а staging часто торчит наружу дольше, чем должен.
- `requireAdminToken(req, expected)` в `auth.js` принимает 2 параметра, но вызывается с тремя — `requireAdminToken(req,ADMIN_TOKEN,{allowLoopback:false})` в `launcher/server.js`. Третий аргумент молча отбрасывается. Само по себе не дыра (аутентификация всё ещё требует токен), но это явный след недоделанного рефакторинга — сигнатуры разъехались, и это ровно тот тип бага, который в следующий раз может выстрелить не молча.
- `ALLOW_LOCAL_ADMIN` в лаунчере проверяет `req.socket.remoteAddress === '127.0.0.1'`. За reverse-proxy (nginx/Caddy на loopback) это условие истинно **для всех запросов**, включая внешние — это стандартный footgun деплоя, который стоит явно задокументировать как "не используйте `TABLETOP_PACK_MANAGER_ALLOW_LOCALHOST=1` за прокси", иначе admin-эндпоинты (install/uninstall пака) открыты всему интернету.

**Что делать:** TLS-терминация — явно описать как обязательную (reverse proxy или встроенный `tls.createServer`), добавить Origin allowlist на уровне `createServer`, поднять `requireIdentity` дефолт для любого non-loopback bind независимо от `NODE_ENV`, почистить сигнатуру `requireAdminToken`.

---

## 2. P1 — Серьёзно, чинить до релиза, не блокирует локальную разработку

### 2.1. Детерминизм — задекларирован, но не enforced рантаймом

Синхронный контракт (`execution.js`) реально хорош: `assertSyncFunction`/`assertSyncResult` жёстко режут `async`/`Promise` на границе команды — это правильный, Gaffer-совместимый выбор ("no wall-clock/network dependency inside simulation"). Но `Date.now()`/`Math.random()` внутри синхронного правила — это тоже нарушение детерминизма, и это **не запрещено рантаймом вообще**, а ловится только опциональным CLI-линтером (`audit-game-pack.cjs`, grep по regex), который не вызывается автоматически при `pack-host.js#load()`. Один `Date.now()` в trigger-хендлере (например, "если игрок отвечает быстрее X — бонус") — и `replayHash()` перестаёт быть воспроизводимым между запуском и повторным воспроизведением, а `exportReplay()`/`replay()` в `replay.js` тихо дадут `matches: false` без объяснения, откуда взялось расхождение.

**Что делать:** минимум — прогонять `audit-game-pack.cjs`-эквивалент как обязательный gate внутри `pack-host.js#refresh()` для zip-паков (а не только как отдельный ручной npm-скрипт); максимум — шимить `Date.now`/`Math.random` внутри `vm.Context`, в котором грузится пак, на детерминированные врапперы поверх `random.js`/`meta.commandSeq`.

### 2.2. `replayHash()` — дорогой per-command, и не различает версию кода правил

`finishCommand()` при `keepCommandHashes: true` вызывает `api.replayHash(PUBLIC)` **на каждую команду**, а `replayHash()` клонирует и стабильно сериализует `snapshot + state + players + effects + scheduled` целиком (`stable()` в `replay.js` — рекурсивный обход с сортировкой ключей). Для большой карточной игры (сотни карт в состоянии, много zones) это O(size(state)) на каждую команду, что при `commandLogCapacity` в тысячи команд быстро становится заметной нагрузкой. boardgame.io и подобные системы для лога полагаются на дельты/патчи команд, а не на full-state hash на каждый шаг — здесь hash полезен для итогового verify (`exportReplay().finalHash`), но включать его *per-command* по умолчанию не стоит; это должно быть явно debug-only.

Отдельно: `replayHash` не включает хэш/версию исходного кода `definition` (только `definition.id`), значит два разных билда правил с одинаковым `id` дадут "совместимый" replay без предупреждения — если игру патчнули (пофиксили баг в effect-резолвере) между записью реплея и его воспроизведением, `replay()` тихо посчитает новый (иной) результат "как есть", и только `matches: false` в конце покажет расхождение — постфактум, без указания, где именно разошлось.

**Что делать:** привязать `manifest.version`/sha256 пака к replay-record (`exportReplay()` уже даже не хранит `definition` version вообще — только `definition: definition.id || null`), сделать per-command hash явно опциональным для профилирования, а не production default.

### 2.3. `EffectStack`/`Scheduler`/`EventDispatcher` — лимиты есть, но это единственная защита от рекурсивных game-rule багов

`drainEffects(limit = 2048)`, `EventDispatcher(limit = 4096)`, `scheduler.due()` — все три ограничены, это правильно (сравнимо с тем, почему в openage время/симуляция отделены от скриптинга — чтобы скриптинг не мог заблокировать цикл). Но при достижении лимита кидается `fail('effect-loop-limit')`/`event-loop-limit` **посреди обработки команды**, и снова см. п.1.2 — без `atomic: true` это ещё один путь к порче state молча, если игра не настроила атомарность.

### 2.4. `TurnOrder.add()` — `assert(!this.ids.includes(id))`, но `players.addPlayer()` не всегда синхронизирован с этим инвариантом при `revive()`

`api.revive(id)` вызывает `turnOrder.add(id)`, который бросает, если игрок уже в `ids` — это нормально в честном сценарии, но `eliminate()` вызывает `turnOrder.remove(id)`, и если игра вызовет `revive()` дважды подряд по ошибке (двойной эффект "воскрешение" в trigger-цепочке), это кинет `GameError`, которая (см. п.1.2) без `atomic` оставит остальную часть эффект-цепочки недоприменённой. Мелкая находка сама по себе, но она — конкретный пример того, почему п.1.2 системно важнее одной строчки.

---

## 3. P2 — Важно, но не горит

- **`game-engine.js` всё ещё god object** (772 строки, ~30 замыканий: dispatch, decision/reaction, effects, scheduler, triggers, state-based rules, save/load, checkpoint, replay hash — в одном файле с общим closure-scope). Собственный аудит это признаёт (P2.7) — согласен, извлечение command-pipeline/persistence уже назрело, дальше тянуть — только наращивать cognitive load ревью.
- **Нет явной capability-декларации на уровне экшена/эффекта** (сравнение с Bevy ECS `Query<&mut X>`): любой `action`/`effect`/`trigger` получает единый `ctx` со всем сразу — `state`, `players`, `random`, `knowledge`, `scheduler`, `emit`, `setPhase`, `finish`. Понять по сигнатуре, что реально трогает конкретное правило, нельзя — тот же диагноз, что и в собственном аудите §3.1, но замечу: рефакторинг context.js/state-view.js вынес *сборку* контекста в отдельный файл, но не сузил сам *набор* capability, доступных каждому вызову. Это косметическое разделение файлов, а не архитектурное сужение доступа.
- **`knowledge.js`/`EventLog.cursors`** — растут по количеству уникальных viewer-принципалов за время жизни матча, без явного TTL/очистки при постоянном уходе игрока (`removePlayer` работает только в lobby, `knowledge.forget` не вызывается при `eliminate`). Не критично для типичной короткой партии, но при долгоживущих "постоянных столах" — медленная утечка памяти на процесс.
- **Дублирование `client/*.js` и `client/browser/*.js`** — на самом деле не проблема: это auto-generated ESM-обёртки с SHA256 в заголовке (`// Source SHA-256: ...`), т.е. билд-артефакт, а не забытый copy-paste. Но в архиве нет самого генератора (`engine-only` дистрибутив), поэтому невозможно проверить, что хэши реально соответствуют текущему `client/*.js` — при аудите нужно **гонять этот генератор в CI** и падать, если хэш разошёлся, иначе это тихий source-of-truth drift.

---

## 4. Что сделано правильно (коротко, чтобы не выглядело как огонь по всему подряд)

- `zip-reader.js`: лимиты на размер архива/файла/суммарный uncompressed/число entries, защита от zip-slip и duplicate entries — сделано аккуратно и с запасом, лучше, чем у среднего самопального zip-парсера.
- `pack-signature.js`/`pack-manager.js`: Ed25519 подпись манифеста+хэшей файлов, staged install с rollback на `.previous-*` — это разумная модель provenance (при условии, что все понимают: подпись ≠ песочница, см. п.1.3).
- Разделение `state`/`presentation` event-стримов с независимыми ring buffer'ами (`events.js`) — прямое и по существу решение проблемы "presentation-события конкурируют за буфер со state-событиями", которую собственный аудит корректно определил как настоящий баг, а не стилевую придирку.
- `EventDispatcher` — FIFO вместо рекурсии на call stack — правильный выбор именно потому, что каскад триггеров в карточной игре (trigger → emit → trigger → emit) — обычное дело, и рекурсивный call stack на JS-движке с шаткими лимитами стека — плохая идея.
- Разделение core/server/client/presentation по сути ближе к Godot-серверам (headless simulation отдельно от presentation layer), чем к типичному "движку", где всё сцеплено — это правильная база, из которой стоит копать глубже, а не переписывать с нуля.

---

## 5. Итоговый приоритетный чеклист

| # | Находка | Severity | Что сделать |
|---|---|---|---|
| 1 | `CardTable.hand()`/state.hands не защищены enforced-visibility | **P0** | Fail-closed projection зон по умолчанию + обязательный runtime self-test снапшота на "утечку чужой руки" перед стартом матча |
| 2 | `dispatch()` не atomic по умолчанию | **P0** | Checkpoint/restore включить по умолчанию, `atomic: false` сделать явным opt-out для перформанса |
| 3 | Untrusted packs исполняются in-process без изоляции | **P0** | Реализовать то, что уже описано в `PACK_SECURITY.md`: worker/process/container изоляция для non-first-party packs |
| 4 | WS без TLS/Origin-check, anonymous join по умолчанию вне production, admin-loopback footgun за прокси | **P0** | TLS обязателен в проде, Origin allowlist, identity required по умолчанию для non-loopback bind |
| 5 | Детерминизм (`Date.now`/`Math.random` в правилах) не проверяется рантаймом | **P1** | Обязательный lint-gate в `pack-host.js#refresh()`, не только ручной CLI |
| 6 | `replayHash` дорогой per-command и не версионирует код правил | **P1** | Debug-only per-command hash, привязка replay к версии/sha256 пака |
| 7 | God object `game-engine.js`, нет capability-декларации на экшен | **P2** | Продолжить извлечение command pipeline; рассмотреть явные "что этот rule трогает" аннотации хотя бы для tooling/lint |
| 8 | `knowledge`/`cursors` растут без TTL при долгих матчах | **P2** | Очистка при `eliminate`/долгом disconnect |
| 9 | `requireAdminToken` сигнатура разъехалась (3 арг vs 2) | **P2** | Почистить, добавить тест на реальное поведение `allowLoopback` |

Если резюмировать одной фразой: **инфраструктурный hardening (сеть, паки, replay) в R1 сделан на совесть, но самое сердце жанра — приватность информации в карточной игре — до сих пор держится на честном слове автора game pack, а не на гарантии ядра.** Это то, что я бы закрыл раньше всего остального в списке, включая P0-security-находки по сети.
