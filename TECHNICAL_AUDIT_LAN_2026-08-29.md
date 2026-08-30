# Жёсткий технический аудит TableCore v2

**Дата:** 2026-08-29<br>
**Объект:** движок пошаговых настольных/карточных игр, game packs, LAN-сервер, игроки и ТВ-доска.<br>
**Целевой режим:** одна игра, до 20 одновременных игроков, локальная сеть.<br>
**Вердикт:** кодовая база — хороший прототип ядра и набор инженерных экспериментов, но **не готовый к эксплуатации LAN-продукт**. Критические продуктовые требования не выполнены: фактический лимит движка — 16, поставляемые игры — максимум 4, сетевой транспорт по умолчанию не доступен из LAN, а запускаемый launcher не поднимает игровой сервер/WebSocket/матч и не предоставляет сквозной сценарий ТВ-доски.

## 1. Область и методика

Проведены: статический разбор пакетов `core`, `server`, `protocol`, `transport-ws`, `worker-pool`, `launcher`, game packs и их manifest-файлов; проверка границ авторизации/видимости; запуск полного тестового набора. Это аудит исходного кода, а не нагрузочное испытание на 20 физических устройствах и не pentest сети.

Шкала: **P0** — блокирует заявленный сценарий или несёт немедленный риск; **P1** — высокий риск потери игры/данных или неверной безопасности; **P2** — существенный долг перед пилотом; **P3** — улучшение качества.

## 2. Факты, подтверждённые проверкой

| Область | Факт | Оценка |
|---|---|---|
| Лимит игроков | `core` жёстко ограничивает match 16 участниками; все заявленные play-pack манифесты задают максимум 4 или вовсе не содержат совместимого поля. | Требование «до 20» нарушено. |
| LAN | WebSocket `listen()` жёстко привязан к `127.0.0.1`; launcher также по умолчанию слушает loopback. | Устройства той же сети не подключатся без доработки/переопределения. |
| Запуск | `npm run launcher` запускает только HTTP-каталог и статические файлы. Он не создаёт `ServerHost`, `ProtocolServer`, токены, WebSocket и match. | Нет готового production entrypoint. |
| UI/TV | В репозитории есть отдельные UI-библиотеки и у Last Sector есть папки `player-ui`, `preview`, `tv-ui`, но launcher даёт маршруты только `play` и `preview`; жизненный цикл игры и выдача ТВ-токена не собраны. | Демонстрационные части, не завершённое изделие. |
| Тесты | `npm test` успешно выполнил 283 теста. | Хорошее покрытие unit/integration-границ, но не доказательство LAN readiness. |
| Надёжность | Матчи хранятся только в памяти. Worker pool при падении намеренно помечает все матчи данного worker как потерянные и не восстанавливает их. | Нельзя обещать продолжение партии после сбоя/обновления. |

## 3. Находки

### P0-01. Заявленные 20 игроков не поддерживаются

**Доказательство.** В `createMatch` константа `MAX_PLAYERS` равна 16 и большее число вызывает исключение. Поставляемые `coin-race`, `grid-duel`, `phase-quest` и `last-sector` декларируют максимум 4 игрока; `sector-expedition` не содержит согласованной продуктовой декларации maxPlayers.

**Последствие.** Сервер не может создать заявленную 20-player игру; даже простое повышение engine-лимита не превратит 2–4-player правила, UI, расположение игроков и UX хода в 20-player режим.

**Рекомендация.** До внедрения UI зафиксировать контракт `1..20` на уровне engine + manifest schema. Добавить preflight, который сверяет `manifest.minPlayers/maxPlayers` с реальной валидацией `game.createInitialState`, и E2E-тест на 20 identities. Для каждого продаваемого pack явно выбрать свой лимит; «движок способен на 20» и «каждая игра поддерживает 20» должны быть разными обещаниями в каталоге.

### P0-02. Сеть по умолчанию локальна только для процесса, не для LAN

**Доказательство.** `createWsServer().listen()` вызывает `httpServer.listen(port, '127.0.0.1')` без параметра host. Launcher имеет configurable host, но его default тоже `127.0.0.1`.

**Последствие.** Телефоны/ноутбуки игроков и ТВ в той же подсети не смогут подключиться к WebSocket; максимум они увидят launcher при специальной переменной окружения, но игрового WS endpoint launcher всё равно не создаёт.

**Рекомендация.** Ввести один конфиг запуска: `bindHost` (безопасный default `127.0.0.1`, LAN-профиль — конкретный private interface/`0.0.0.0`), HTTP+WS на одном origin, отображение выбранного LAN URL/QR, явный allowlist Origin для LAN-профиля. Проверить с отдельного хоста, а не loopback-тестом.

### P0-03. Нет единого запускаемого продукта «создать игру → присоединиться → играть → ТВ»

**Доказательство.** Единственный npm script запуска — `launcher`; он обслуживает каталог и статические UI. Создание и проведение матча существуют как библиотечные методы `ServerHost`, WebSocket требует внешних `protocol`, `resolveConnection`, `auth`; в launcher эти слои не композиционируются. Нет HTTP/API для lobby, issuance/revocation токенов, выбора роли ТВ, выдачи приглашения и graceful shutdown матча.

**Последствие.** Интегратор должен сам написать наиболее рискованную часть системы: auth, доступ к матчам, orchestration и deployment. Наличие отдельных тестов библиотек не означает, что пользователь может сыграть партию.

**Рекомендация.** Сделать `apps/lan-server` единственным поддерживаемым entrypoint: config validation, game registry, create/join/start/reconnect API, QR/invite, WS upgrade, TV role, metrics/health, shutdown/checkpoint. Launcher оставить frontend-каталогом или встроить в этот app. Добавить один black-box E2E-тест через реальные HTTP/WS соединения: 20 игроков + ТВ.

### P1-01. Сбой worker/process приводит к безвозвратной потере партии

**Доказательство.** `ServerHost` держит `Map` матчей в RAM. Документация и код `MatchWorkerPool` прямо фиксируют модель «terminated and reported»: при retire удаляется маршрутизация всех матчей worker, state recovery отсутствует.

**Последствие.** Ошибка rule pack, memory limit, зависание, перезапуск процесса или обновление сервера обрывают игру. Для настольной партии это заметный продуктовый дефект, особенно при скрытой информации: нельзя корректно «просто пересоздать» state на клиенте.

**Рекомендация.** Перед пилотом реализовать append-only action log + периодический атомарный checkpoint (state, version, RNG state, pack/content digest) в локальном durable storage. При рестарте: проверка provenance, загрузка checkpoint, детерминированное воспроизведение хвоста, версия/событие `MATCH_RECOVERED`. Сначала выбрать понятную политику: recover, abort с экспортом replay, либо запрет на worker pool для живой партии — не оставлять неявную потерю.

### P1-02. Граница доверия game pack не соответствует механизму исполнения

**Доказательство.** Подпись/artifact lint проверяют происхождение и метаданные пакета, но `worker_threads` исполняет JS с теми же возможностями процесса: filesystem, сеть, environment и imports Node built-ins. Сам код это честно документирует. Regex-проверки linter по `Function#toString()` также не являются AST-анализом или sandbox.

**Последствие.** «Подписанный» означает «доверенный ключом», а не «безопасный сторонний код». Пакет с доверенным/скомпрометированным ключом может читать секреты сервера, сканировать LAN, модифицировать файлы или удерживать worker до watchdog. Для LAN это особенно опасно, когда сервер запускается на личном компьютере организатора.

**Рекомендация.** Явно разделить режимы: (a) built-in/trusted packs допускаются в-process; (b) third-party packs — отдельный OS-процесс/контейнер с deny-by-default FS/network/env, read-only bundle и лимитами. Не рекламировать подпись как песочницу. Использовать AST lint только как quality gate, не security control.

### P1-03. TV-права и видимость событий требуют дисциплины каждого pack

**Доказательство.** Protocol корректно фильтрует event целиком по `audience`/role и строит viewer-specific snapshot. Но публичное событие не редактируется по полям: вложенный секрет в public event попадёт всем. Linter для hidden-information pack лишь предупреждает, когда события не имеют audience; это не blocking error.

**Последствие.** Одна ошибка автора pack при добавлении event может раскрыть карты/координаты/ресурсы игрокам или ТВ. ТВ по определению не является «безопасным публичным экраном»: его audience и snapshot policy должны быть описаны отдельно.

**Рекомендация.** Ввести типизированную event schema c обязательной классификацией (`public`, `players`, `roles`, `server-only`) и validate на runtime. Для `hiddenInformation:true` запрещать public events с полями, помеченными private, а отсутствие audience для event требовать как осознанный `public: true`. Добавить contract tests каждого pack: player A, player B, spectator и TV получают допустимые данные для каждого типа события.

### P2-01. Масштабирование до 20 игроков не измерено и текущая рассылка делает дорогостоящую работу N раз

**Доказательство.** При UPDATE transport проходит по подписчикам и для каждого вызывает `protocol.buildUpdate`: проекция snapshot, `structuredClone`, event filter, diff и JSON encoding. `ServerHost` кэширует проекцию на viewer/version, но после каждого принятого действия полностью очищает cache. Существующие benchmarks/тесты преимущественно проверяют корректность и малые demo states, а не SLO с 20 игроками + ТВ по Wi‑Fi.

**Последствие.** При типичной настольной игре это, вероятно, терпимо, но это непроверенное предположение. Большая карта или дорогой `getPlayerView` дадут O(число зрителей × размер проекции) на ход и могут задерживать UI всех клиентов.

**Рекомендация.** Определить SLO: p95 от ACTION до UPDATE, max snapshot/patch bytes, event-loop lag, CPU/RSS на 20 players + TV. Провести soak 2–4 часа на representative pack и Wi‑Fi. Кэшировать общие public/TV проекции, ограничить размер state/event/action, ввести acknowledgement/base-version для patch и измерить full snapshot fallback.

### P2-02. Безопасность LAN зависит от незафиксированной конфигурации

**Доказательство.** Origin validation включается только если передан `allowedOrigins`; иначе Origin не проверяется. TLS опционален. TTL токенов по умолчанию час, а revocation store по умолчанию in-memory; при restart все отозванные токены снова валидны, если secret прежний.

**Последствие.** Для доверенной домашней LAN это может быть приемлемо только как сознательный режим. В офисной/публичной сети HTTP/WS и bearer token допускают перехват/повторное использование; браузерный Origin сам по себе не заменяет authentication.

**Рекомендация.** Описать threat model и отдельные profiles: `home-lan` (короткоживущие одноразовые invite, bind private interface, visible warning), `managed-lan` (TLS/WSS, origin allowlist, persistent revocation or key rotation). Не считать проверку Origin защитой от non-browser клиента.

### P2-03. Контракт game pack и delivery-процесс не завершены

**Доказательство.** В манифестах смешаны схемы (`id/apiVersion` и `gameId/engineCompatibility`), статусы всех игр `preview`, часть demo packs не имеет полноценного manifest/authoring surface. `last-sector` — единственный auto-discovered playable pack; launcher не имеет явного TV route. В корне нет CI workflow, lint, typecheck, Node `engines`, release/migration policy или SBOM.

**Последствие.** Совместимость пакетов и процесс выпуска будут деградировать при расширении каталога. «Game pack» пока означает несколько разных уровней зрелости.

**Рекомендация.** Версионировать JSON schema manifest, отклонять legacy schema в release profile, добавить capability matrix (players/TV/hidden info/reconnect/max players), release gate `npm ci && npm test && pack-lint && E2E`, фиксированную Node LTS версию и dependency audit. Отделить fixtures от installable packs.

### P2-04. Генератор test provenance терял фактический результат тестов на текущем Node — исправлено

**Первопричина.** Генератор искал строки формата `# tests`, `# pass`, `# fail`, тогда как текущий `node --test` выводит итоговые строки с символом `ℹ`.

**Исправление.** Генератор теперь принимает оба формата префикса и аварийно завершает работу, если после успешного `npm test` не может извлечь любой из трёх счётчиков. Обновлённый manifest содержит фактические total/pass/fail.

**Остаточный риск.** Предпочтителен machine-readable reporter (`node --test --test-reporter=...`) и отдельный unit test генератора на поддерживаемых версиях Node; пока parser намеренно fail-closed, а не записывает `null`.

## 4. Сильные стороны

1. **Авторитарная симуляция и version check.** Игрок не может подменить actor; stale action отвергается; state выдаётся через per-viewer projection.
2. **Хорошая базовая защита транспорта.** Есть лимит сообщений, размер receive buffer, лимит pending handshake, auth timeout, backpressure disconnect, строгая обработка WebSocket frame/UTF‑8 и последовательная обработка сообщений одного соединения.
3. **Корректный курс на детерминизм.** Seeded RNG, replay provenance и отказ от `Math.random`/wall-clock в правилах — правильная основа для диагностики и восстановления.
4. **Разделение слоёв.** `core`/`server`/`protocol`/`transport`/`presentation` хорошо отделены, а worker-pool изолирует crash/CPU loop одной группы матчей от main thread.
5. **Тестовая дисциплина выше обычного для прототипа.** 283 зелёных теста включают privacy, auth, RFC6455, backpressure, worker crash/timeout и WebSocket E2E.

Эти достоинства не отменяют P0: они делают проект хорошей основой для следующей инженерной итерации, а не готовой LAN-системой.

## 5. Целевая архитектура для заявленного сценария

```
Browser player / TV
        │ HTTPS + WSS (one LAN origin)
        ▼
apps/lan-server: lobby, invite/role issuance, game registry, health/metrics
        │ command queue / per-match affinity
        ├────────────► trusted match worker
        │                   │ deterministic core + pack
        │                   └──► checkpoint + action log (durable local storage)
        ▼
viewer projection + event classification + patch/full snapshot policy
        ▼
player UI / TV UI (different explicit capabilities)
```

Принципы: server authoritative; UI никогда не владеет state; TV — отдельная роль и ACL; pack — data+rules с declared capabilities; persistence принадлежит host, не pack; transport не знает правил игры; один матч последовательно исполняется на одном worker.

## 6. План исправлений и критерии готовности

### Этап A — заблокировать ложный launch (P0, до любого пилота)

1. Либо временно изменить документацию/UX на «demo, 2–4 players, localhost», либо реализовать `apps/lan-server`.
2. Задать сквозную конфигурацию bind host/port/origin/TLS и LAN QR URL; открыть WS на выбранном LAN интерфейсе.
3. Реализовать lobby/create/join/start/reconnect и issuance отдельного TV token; интегрировать launcher/UI.
4. Исправить контракт лимитов: engine 20, manifest validation, catalog показывает фактический лимит pack.

**Gate:** с трёх независимых LAN clients и одного TV: create → join → start → action → reconnect → TV update. Для engine — отдельный 20-player smoke; для каждого pack — честно задекларированный max.

### Этап B — надёжность и приватность (P1)

1. Durable action log + checkpoint/recovery; экспортируемый replay для abort path.
2. Event schema/classification и четыре viewer-contract tests на pack.
3. Trust tiers и OS-level isolation для third-party packs; capability policy как runtime, а не только lint.

**Gate:** kill worker/process в середине партии и восстановить версию/state/RNG; secret fixtures не появляются ни в player B, ни spectator, ни TV при запрещённой политике.

### Этап C — производительность и эксплуатация (P2)

1. Нагрузочный/soak стенд 20 players + TV с эталонным hidden-info pack.
2. Метрики Prometheus/JSON endpoint: event-loop lag, p50/p95 action latency, WS queue/drop, snapshot/patch bytes, worker crashes, checkpoint latency.
3. CI/release gates, manifest schema, Node version, dependency/secret scan, runbook backup/upgrade/key rotation.

**Предварительный SLO для LAN:** p95 ACTION→UPDATE <250 ms на 20 players + TV на целевой машине; p99 <1 s; нет роста RSS в 2-hour soak; при рестарте потеря подтверждённых ходов = 0 либо явно измеренный и документированный RPO.

## 7. Итог

Не рекомендую объявлять систему готовой для заявленной LAN-эксплуатации. Рекомендую сохранить текущее ядро, не переписывать его, и инвестировать в composition/deployment, durable lifecycle и чёткий 20-player contract. Самые важные действия — не новая игровая механика и не косметика ТВ UI, а закрытие P0-01/P0-02/P0-03; без них «сервер, игроки и ТВ-доска в LAN» существует только как набор библиотечных возможностей, а не как поставляемый продукт.
