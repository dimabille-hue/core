# LAST SECTOR — AGGRESSIVE R1 GAME-PACK AUDIT

Version: `1.40.1`  
Target engine: `Tabletop Engine 1.40.111-R1`  
Pack: `game-pack-last-sector.zip`  
Audit date: 2026-08-28  
Verdict: **BLOCKED**

## Executive verdict

The Last Sector ruleset is not a failed game. Its core simulation logic can be instantiated directly against the R1 engine and survives deterministic gameplay fuzzing across multiple seeds and bundled scenarios.

However, the **pack as distributed is not R1-certifiable and does not work end-to-end through the R1 distribution/server/browser path**.

There are multiple independent blockers:

1. The production pack entry exports a `createDefinition()` factory, while R1 `MatchHost` expects an already-materialized game definition. A real `MatchHost` instantiation fails with `projection-required`.
2. The pack's player/TV browser code imports several root-level files (`../client-state.mjs`, `../assets.mjs`, `../presentation.mjs`, `../tutorial.mjs`). R1's public allowlist does not publish those files.
3. Worse, the current R1 `resolveFile()` implementation is vulnerable to path traversal through an allowed directory prefix. A request such as `player-ui/../game.js` is accepted and the actual launcher serves `game.js`. This is primarily an **engine bug**, but it materially affects this pack and must be fixed before certification.
4. The pack's visibility rules promise `first-discoverer` loot, but `RESOURCE_COLLECTED` is broadcast publicly with exact `type` and `value`. A private artifact therefore becomes public knowledge through the event stream.
5. The pack's client reducer is far behind the actual event contract. It handles only a small subset of the current state events, does not handle `TURN_CHANGED`, and does not update combat damage/shield/fuel/respawn/tanker state. Non-actor clients therefore become visibly stale.
6. `presentation.mjs` registers handlers for state-stream events that never reach the presentation stream, while two actual presentation events (`GLITCH_EFFECT`, `SHIP_DESTROYED`) have no handlers. Several animations are therefore dead or inconsistent.
7. `manifest.engineCompatibility` claims `>=1.39.0 <2.0.0`, which is too broad for a pack that relies on the 1.40/R1 execution contract.
8. `publicPaths` is omitted, so the pack relies on the engine default rather than declaring an explicit public ABI.
9. R1 replay certification is currently undermined by an engine issue: the exported replay does not capture pre-start lifecycle actions such as `ready()`, so the same command log can produce a different final revision/hash.
10. R1 replay hashing does not serialize `Map`/`Set` contents in its stable hash. Last Sector stores major canonical state in `Map`, so hidden state can be changed without changing `replayHash()`.

The recommendation is therefore:

> **Do not publish this pack against R1. Repair the R1 engine security/replay issues first, then migrate Last Sector to the R1 pack contract, then certify the game with a dedicated pack regression suite.**

---

# 1. Evidence and test environment

The audit used the supplied ZIP and a clean extraction.

Pack inventory:

- 43 ZIP entries
- `manifest.json`
- `index.js`
- `game.js` (~37.7 KB / 262 source lines, heavily packed)
- player UI
- TV UI
- preview
- content pack
- scenarios
- presentation modules
- client state reducer

The R1 engine was extracted from the previously produced refactored engine distribution.

## Automated R1 pack audit

Command:

```bash
node tools/audit-game-pack.cjs game-pack-last-sector.zip
```

Result:

```json
{
  "verdict": "BLOCKED",
  "findings": [
    "direct-node-io-in-rule-code",
    "process-global-access-in-rule-code"
  ],
  "warnings": [
    "player-capability-without-explicit-publicPaths",
    "tv-capability-without-explicit-publicPaths"
  ]
}
```

The first two findings are partially false-positive at implementation level because the offending code is the scenario/content loading adapter rather than a gameplay callback. Nevertheless, they correctly identify that the pack's server entry transitively depends on filesystem/process globals and therefore does not match the stricter R1 packaging boundary.

---

# 2. What actually works

This distinction matters.

## Direct engine execution

Using:

```js
const { createDefinition } = require('./game');
const definition = createDefinition({ playerCount: 2 });
const engine = createEngine(definition, { seed: 123 });
```

the pack successfully:

- initializes a 2-player game;
- creates deterministic boards;
- starts a match;
- executes movement;
- executes turn changes;
- performs loot pickup;
- performs delivery;
- reaches victory;
- performs save/load into a fresh engine;
- survives deterministic legal-play fuzzing;
- executes bundled scenarios.

## Scenario fuzzing

The following bundled scenarios were exercised across multiple seeds:

- `combat-demo`
- `discovery-demo`
- `demo-party`

Each scenario survived a 350-step legal-action fuzz loop with invariants checking:

- no negative fuel;
- no negative action points;
- HP not above max;
- units remain on-board;
- cargo does not exceed capacity;
- scores remain finite;
- advertised actions are executable.

Also tested a 4-player direct definition across several seeds.

Result:

```text
SCENARIO_FUZZ_PASS
4-player direct simulation: PASS
```

This is strong evidence that the game rules themselves are not fundamentally broken.

---

# 3. CRITICAL — Production entry is incompatible with R1 MatchHost

## Evidence

`manifest.json`:

```json
{
  "entry": "index.js"
}
```

`index.js`:

```js
module.exports = require('./game');
```

`game.js` exports:

```js
module.exports = {
  createDefinition,
  SHIPS,
  LOOT
};
```

Therefore:

```js
packHost.load('last-sector').definition
```

is:

```text
{
  createDefinition,
  SHIPS,
  LOOT
}
```

and **not**:

```text
{
  id,
  project,
  actions,
  createState,
  ...
}
```

R1 `MatchHost` passes the loaded value directly to:

```js
createEngine(definition)
```

which immediately asserts:

```text
projection-required
```

## Reproduction

Real `MatchHost` test:

```text
raw export keys:
createDefinition
SHIPS
LOOT

MATCH_ENGINE_ERROR:
projection-required
```

An actual WebSocket connection to:

```text
/games/last-sector?match=default
```

connected at transport level and then immediately closed because the host could not instantiate the game definition.

## Severity

**CRITICAL / BLOCKER**

The game cannot start through the supplied R1 server.

## Correct solution

Do not hide this with a one-line export hack.

There are two valid architectures.

### Preferred

Extend pack loading to support:

```js
module.exports = createDefinitionFactory(...)
```

with an explicit factory contract:

```text
load pack
→ load factory
→ instantiate definition for match
→ freeze match definition/version
```

The factory must receive a **validated server-side match configuration**, not arbitrary client data.

### Alternative

Materialize a definition with:

```text
minPlayers = 2
maxPlayers = 4
```

and derive actual player count from `ctx.players.size`.

This is actually the better Last Sector model, because the current code incorrectly couples `cfg.n` to exact min/max player count.

---

# 4. CRITICAL — Manifest says 2–4 players, definition is exact-N

Manifest:

```text
minPlayers = 2
maxPlayers = 4
```

But:

```js
cfg.n = +options.playerCount || 2;

minPlayers: () => cfg.n,
maxPlayers: () => cfg.n
```

Measured:

```text
playerCount = 2 → min=2 max=2
playerCount = 3 → min=3 max=3
playerCount = 4 → min=4 max=4
```

Therefore there is no actual 2–4 player definition.

The pack must decide:

### Fixed-size mode

Then the manifest must reflect the fixed size.

### Variable-size mode

Then:

```text
minPlayers() = 2
maxPlayers() = 4
```

and setup must use:

```text
const playerCount = ctx.players.size
```

instead of a compile-time `cfg.n`.

This is especially important for:

- base placement;
- trap availability;
- board scaling;
- player elimination;
- victory;
- spawn configuration.

---

# 5. CRITICAL — Browser runtime cannot import its own root modules through R1 publicPaths

Player UI imports:

```js
../client-state.mjs
../assets.mjs
```

TV UI imports:

```js
../presentation.mjs
../client-state.mjs
../assets.mjs
../tutorial.mjs
```

But the pack has no explicit `publicPaths`.

R1 default public allowlist is:

```text
preview/
player-ui/
tv-ui/
assets/
public/
```

Consequently:

```text
client-state.mjs
assets.mjs
presentation.mjs
tutorial.mjs
assets.svg
```

at the root of the pack are not public.

Actual launcher test:

```text
player-ui/index.html       → 200
player-ui/main.js          → 200
client-state.mjs           → 404
assets.svg                 → 404
game.js                    → 404 (normal path)
```

Thus the player/TV applications cannot complete module resolution.

## Correct solution

Preferred:

```text
shared/
```

cannot be public implicitly; instead explicitly expose a client-only tree:

```text
player-ui/lib/
tv-ui/lib/
shared-ui/
```

or:

```text
public/
  last-sector/
    assets.mjs
    client-state.mjs
    presentation.mjs
    tutorial.mjs
    assets.svg
```

and define:

```json
"publicPaths": [
  "preview/",
  "player-ui/",
  "tv-ui/",
  "assets/",
  "shared-ui/"
]
```

Do not expose the root of the pack.

---

# 6. CRITICAL ENGINE SECURITY BUG — public-path traversal

This is primarily an R1 engine defect discovered while auditing Last Sector.

`resolveFile()` performs the public-prefix test before collapsing `..`.

A path:

```text
player-ui/../game.js
```

begins with an allowed public root and therefore passes the allowlist check.

The final filesystem resolution then lands on:

```text
game.js
```

Actual test through the launcher:

```text
/games/last-sector/player-ui/../game.js
→ HTTP 200
→ game.js source returned
```

The same attack exposed:

```text
index.js
content/pack.json
scenarios/combat-demo.json
game.js
```

## Why this is worse than it looks

The pack's simulation code is now retrievable over the public launcher.

For a hidden-information game, source disclosure may reveal:

- loot odds;
- secret rules;
- hidden object placement logic;
- victory mechanics;
- AI-related future logic;
- exploit paths.

It also invalidates the intended:

```text
publicPaths
```

security boundary.

## Engine fix

Normalize first:

```text
decode
→ normalize POSIX separators
→ collapse dot segments
→ reject absolute path
→ verify it is still inside pack root
→ verify it belongs to declared public root
→ serve
```

Then test:

```text
player-ui/../game.js
preview/../manifest.json
tv-ui/../../...
```

against a regression corpus on both Linux and Windows path semantics.

Do not certify any pack until this is fixed.

---

# 7. CRITICAL — Hidden loot is leaked through state events

This is a genuine Last Sector ruleset privacy defect.

Manifest/content says:

```json
"technology": {
  "visibility": "first-discoverer"
}
```

and similarly for:

```text
artifact
ancient
```

The projection correctly hides this information from the other player.

However, when the item is collected, `game.js` emits:

```js
ctx.emit('RESOURCE_COLLECTED', {
  player: u.owner,
  type: picked.type,
  value: picked.value
});
```

with no private audience.

The actual reproduction using `discovery-demo`:

```text
p1 discovers artifact
```

p2 receives:

```json
{
  "type": "RESOURCE_COLLECTED",
  "payload": {
    "player": "p1",
    "type": "artifact",
    "value": 7000
  }
}
```

Therefore:

```text
projection privacy = PASS
event privacy      = FAIL
```

## Severity

**CRITICAL**

## Fix

For first-discoverer loot:

```js
ctx.emit(
  'RESOURCE_COLLECTED',
  { player, /* safe information only */ },
  player
);
```

or split into:

```text
RESOURCE_COLLECTED_PUBLIC
RESOURCE_COLLECTED_PRIVATE
```

Better:

```text
Canonical event
    ↓
viewer projection
    ↓
transport event
```

Never put the secret item identity in a public canonical payload.

---

# 8. HIGH — Client state reducer is not compatible with current event contract

`client-state.js` recognizes only:

```text
SHIP_MOVED
TELEPORTED
FORCED_MOVE
PLAYER_SHIP_DESTROYED
CARGO_DELIVERED
SIGNAL_GOOD
TRAP_PLACED
TURN_STARTED
```

But the game actually emits:

```text
ACCELERATOR_PUSH
ANOMALY_RESOLVED
ASTEROID_EXIT_PROGRESS
CARGO_DELIVERED
COLLISION
COMBAT_RESOLVED
DAMAGE
FUEL_PURCHASED
LOOT_STOLEN
NAVIGATION_GLITCH
NEBULA_ENTERED
NEBULA_EXIT_PROGRESS
PIRATE_RESOLVED
PLAYER_SHIP_DESTROYED
RESOURCE_COLLECTED
SCAN_RESOLVED
SECTOR_COLLAPSE
SECTOR_GENERATED
SHIELD_BROKEN
SHIP_MOVED
SHIP_REPAIRED
TANKER_ATTACKED
TANKER_DESTROYED
TANKER_SPAWNED
TRAP_PLACED
TRAP_TRIGGERED
```

That is a huge contract mismatch.

## Concrete reproduction

A p2 client receives an initial snapshot after its own move.

Then p1 attacks p2.

Server:

```text
shield: 1 → 0
```

p2 receives:

```text
SHIELD_BROKEN
COMBAT_RESOLVED
```

The reducer ignores both.

Observed:

```text
client shield = 1
server shield = 0
```

The server also changed:

```text
active: p2 → p1
```

but the client reducer does not handle:

```text
TURN_CHANGED
```

It only knows:

```text
TURN_STARTED
```

which the current ruleset never emits.

## Consequence

Non-actor clients can display:

- wrong shield;
- wrong HP;
- wrong fuel;
- wrong movement points;
- wrong active player;
- stale tanker state;
- stale collision state;
- stale repair state;
- dead ships after they actually respawn;
- stale map/effect information.

This is not just a cosmetic problem. It makes multiplayer gameplay UI unreliable.

---

# 9. HIGH — MatchHost only snapshots the actor after a command

R1 `flushAfterCommand()` sends a full snapshot to the actor, while other sessions receive event deltas.

That is perfectly reasonable only if the pack's client reducer is complete.

Last Sector's reducer is not complete.

Therefore the architecture currently forms:

```text
actor
  → snapshot
  → correct state

other clients
  → partial event reducer
  → stale state
```

## Correct options

### Option A — Improve pack reducer

Implement a complete authoritative-to-client projection delta model.

### Option B — Engine sends snapshot whenever an event cannot be safely reduced

This costs bandwidth.

### Preferred

Introduce a formal client projection delta contract, so the pack author explicitly declares which state events are reconstructive.

Do not make a generic client reducer guess.

---

# 10. HIGH — Ship respawn is not represented correctly

`destroyIfNeeded()`:

```text
hp <= 0
→ emit PLAYER_SHIP_DESTROYED
→ decrement lives
→ if lives remain:
     move to home
     repair
     keep player
```

But the client reducer always does:

```text
PLAYER_SHIP_DESTROYED
→ status = destroyed
```

There is no:

```text
PLAYER_SHIP_RESPAWNED
```

event.

Therefore another player's client can permanently show a ship as destroyed when it has actually returned to base with remaining lives.

This is a direct gameplay UI correctness bug.

Recommended events:

```text
SHIP_DESTROYED
SHIP_RESPAWNED
PLAYER_ELIMINATED
```

These are semantically different states and should not be overloaded.

---

# 11. HIGH — Tanker state cannot be maintained by the current reducer

The rules emit:

```text
TANKER_SPAWNED
TANKER_ATTACKED
TANKER_DESTROYED
```

The reducer handles none.

The tanker is public information, so non-actor players should see it appear/disappear.

Currently they rely on future snapshots to discover this.

---

# 12. HIGH — Presentation contract is internally inconsistent

Actual presentation-stream events emitted by `game.js`:

```text
COMBAT_FLASH
FORCED_MOVE_EFFECT
GLITCH_EFFECT
ROUTE_HIGHLIGHT
SHIP_DESTROYED
SHIP_MOVE_ANIMATION
```

`presentation.mjs` handlers include:

```text
SHIP_MOVE_ANIMATION
ROUTE_HIGHLIGHT
SHIP_MOVED
COMBAT_FLASH
COMBAT_RESOLVED
TELEPORT_EFFECT
TELEPORTED
FORCED_MOVE_EFFECT
SCAN_RESOLVED
SECTOR_DISCOVERED
TRAP_PLACED
PLAYER_SHIP_DESTROYED
TANKER_DESTROYED
```

Problems:

### Dead handlers

These are state-stream concepts, not presentation-stream events:

```text
SHIP_MOVED
COMBAT_RESOLVED
SCAN_RESOLVED
TRAP_PLACED
PLAYER_SHIP_DESTROYED
TANKER_DESTROYED
```

The TV presentation dispatcher is fed with:

```text
stream === "presentation"
```

so these state events never reach these handlers.

### Missing actual handlers

Actual presentation events without handlers:

```text
GLITCH_EFFECT
SHIP_DESTROYED
```

## Result

At minimum:

- glitch presentation is missing;
- ship destruction presentation is missing;
- teleport presentation paths are suspicious because the rules do not emit `TELEPORTED`;
- scan presentation handler is dead because scan currently emits state only.

The presentation API should be rebuilt around **actual emitted presentation events**, not around a mixture of state and presentation vocabulary.

---

# 13. HIGH — Teleport events are declared but not actually emitted

`teleport()` changes the unit position, but the function does not emit:

```text
TELEPORTED
```

`brokenTeleport()` likewise changes the unit without emitting a corresponding semantic state/presentation event.

Yet presentation code is built around:

```text
TELEPORTED
TELEPORT_EFFECT
```

This is a contract hole.

At minimum:

```text
SHIP_MOVED
```

must carry an explicit movement cause:

```text
cause: "teleport"
```

or a dedicated canonical event should be emitted.

---

# 14. MEDIUM/HIGH — `combat-demo` does not begin in a combat-valid state

The bundled scenario places:

```text
p1: 1,1
p2: 2,1
```

but p2's unit is on its home base.

The combat rule explicitly prevents attacking units that are at home.

Therefore the intended demo opening:

```text
adjacent enemy ships
```

is actually:

```text
adjacent but protected home target
```

A direct first attack returns:

```text
value: false
```

This is a scenario/design bug, not a core combat bug.

If the scenario is meant to demonstrate combat, start p2 off-base or move it before the demo attack.

---

# 15. MEDIUM — Broad engineCompatibility is unsafe

Current:

```text
>=1.39.0 <2.0.0
```

This is not credible for a pack using a rapidly evolving engine ABI.

The pack relies on semantics such as:

```text
ctx.emitPresentation
ctx.knowledge
ctx.random
projection
R1 server loading
browser runtime
```

Recommended:

```text
1.40.x
```

or at most:

```text
>=1.40.111 <1.41.0
```

until compatibility matrices exist.

---

# 16. MEDIUM — publicPaths should be explicit

The current pack relies on the R1 default.

For a production pack, this should be:

```json
"publicPaths": [
  "preview/",
  "player-ui/",
  "tv-ui/",
  "assets/",
  "shared-ui/"
]
```

with root-level client modules moved into `shared-ui/`.

Explicit declaration makes review deterministic.

---

# 17. MEDIUM — Rule code is mixed with filesystem/process bootstrap

The automated audit flags:

```text
content/index.js
scenarios/index.js
game.js
```

because these use:

```text
fs
process.env.TABLETOP_ENGINE_API_ROOT
```

The content/scenario loaders are infrastructure adapters, not gameplay operations, so this is not equivalent to:

```text
Math.random()
network I/O
database I/O
```

inside a rule callback.

Nevertheless, the pack should migrate to:

```text
server entry
   ↓
load static definition data
   ↓
pure/in-memory domain modules
```

A cleaner future contract is:

```text
server.js
domain/
  rules.js
  board.js
  combat.js
  projection.js
  scenarios.js
```

while file loading is performed once by the pack loader/build stage.

---

# 18. MEDIUM — Replay certification currently fails at engine level

Two identical simulations with the same seed and commands produced the same ordinary deterministic hash.

However:

```text
exportReplay()
→ replay()
```

produced:

```text
expected hash != actual hash
```

Root cause:

The replay export records the final player state, but not all pre-start lifecycle transitions.

Example:

```text
original:
addPlayer
addPlayer
ready
ready
start
...
```

replay:

```text
addPlayer(player already ready)
addPlayer(player already ready)
start
...
```

The resulting gameplay state can be equivalent, but the engine revision differs.

Since revision participates in the hash:

```text
final hash differs
```

This is an R1 engine problem, but it blocks Last Sector replay certification.

---

# 19. CRITICAL ENGINE ISSUE — `Map` contents are not represented by replay stable hash

R1 `stable()` handles:

```text
null
primitive
array
object
```

but not:

```text
Map
Set
```

For a `Map`, `Object.keys(map)` is empty.

Last Sector stores major canonical state in:

```text
state.tiles
state.units
state.scores
state.discovered
```

all as `Map`.

Concrete reproduction:

```text
hash before hidden unit mutation
==
hash after hidden unit mutation
```

even though authoritative hidden state changed:

```text
u2.hp = 3 → 1
```

and public projection remained unchanged.

This means the current replay hash can claim two different hidden game states are identical.

The engine fix must serialize:

```text
Map → sorted array of key/value pairs
Set → sorted array of members
```

with a canonical representation.

Only after that should Last Sector use `replayHash` as a certification artifact.

---

# 20. Medium — random comparator in scan logic

Current scan logic uses:

```js
validDirs.sort(() => ctx.random.next() - 0.5)
```

Problems:

- biased shuffle;
- sort semantics are not a proper RNG primitive;
- portability across runtimes/engine implementations is weaker.

Replace with:

```js
ctx.random.shuffle(validDirs)
```

then take the first N entries.

This is small, but it belongs in a deterministic engine ruleset.

---

# 21. Medium — single large `game.js` is now a maintainability risk

The current ruleset is approximately 38 KB compressed into 262 long source lines.

One file contains:

```text
configuration
grid math
board generation
spawning
movement
cargo
loot
visibility
discovery
combat
collision
teleport
scan
traps
tankers
global events
sector collapse
victory
turn transition
state rules
projection
```

This is not an immediate runtime blocker.

It is, however, a strong auditability problem.

Recommended split:

```text
domain/
  config.js
  grid.js
  board.js
  ships.js
  movement.js
  combat.js
  loot.js
  discovery.js
  special-tiles.js
  tanker.js
  victory.js
  projection.js
  rules.js
server.js
```

The objective is not more files for their own sake. The objective is making each invariant locally reviewable.

---

# 22. Low/Medium — dead configuration knobs

The configuration contains:

```text
cfg.fuel
cfg.mp
```

and fields:

```text
maxFuel
movePoints
```

but these do not actually control ship initialization because ship definitions in the content pack are authoritative.

That is dangerous API design because users can believe:

```text
movePoints = 2
```

changes gameplay when it does not.

Remove dead knobs or make them functional.

---

# 23. Recommended migration architecture

## Phase A — engine blockers

Before touching gameplay:

```text
1. Fix public-path canonicalization.
2. Fix Map/Set replay hashing.
3. Make replay capture pre-start lifecycle.
4. Decide factory-vs-materialized definition contract.
5. Add explicit match configuration path.
```

## Phase B — Last Sector server migration

Refactor:

```text
index.js
game.js
content/index.js
scenarios/index.js
```

into an R1 entry:

```text
server.js
domain/
  board.js
  movement.js
  combat.js
  loot.js
  projection.js
  scenarios.js
```

Set:

```text
publicPaths
engineCompatibility: "1.40.x"
```

and make:

```text
minPlayers = 2
maxPlayers = 4
```

independent of a hard-coded `cfg.n`.

## Phase C — privacy

Define separate event contracts:

```text
public state event
private player event
presentation event
```

especially for:

```text
RESOURCE_COLLECTED
```

and rare loot.

## Phase D — client state

Replace the partial reducer with a deliberate client projection mechanism.

At minimum cover:

```text
TURN_CHANGED
DAMAGE
SHIELD_BROKEN
FUEL_PURCHASED
SHIP_REPAIRED
TANKER_SPAWNED
TANKER_DESTROYED
PLAYER_SHIP_DESTROYED
SHIP_RESPAWNED
RESOURCE_COLLECTED
LOOT_STOLEN
TRAP_TRIGGERED
NEBULA_EXIT_PROGRESS
ASTEROID_EXIT_PROGRESS
NAVIGATION_GLITCH
SECTOR_COLLAPSE
```

## Phase E — presentation

Make one authoritative mapping table:

```text
canonical presentation event
→ sequence / FX
```

Remove handlers for state events.

Add:

```text
GLITCH_EFFECT
SHIP_DESTROYED
```

and actually emit teleport events where required.

## Phase F — certification tests

Every pack release should contain:

```text
tests/
  startup.test.cjs
  movement.test.cjs
  combat.test.cjs
  visibility.test.cjs
  replay.test.cjs
  save-load.test.cjs
  reconnect.test.cjs
  four-player.test.cjs
  client-events.test.cjs
```

---

# 24. Mandatory golden tests for Last Sector

## Golden #1 — startup

```text
2 players
seed fixed
→ board generated
→ correct bases
→ correct hidden/public state
```

## Golden #2 — first-discoverer privacy

```text
p1 acquires artifact
→ p1 knows artifact
→ p2 does not
→ public events contain no artifact identity/value
```

## Golden #3 — public-after-discovery

```text
p1 discovers mineral
→ public projection changes
→ p2 sees mineral afterwards
```

## Golden #4 — combat

```text
attack shield
→ SHIELD_BROKEN
→ second attack damages hull
→ third attack destroys/respawns
```

## Golden #5 — respawn

```text
lives > 0
→ destruction
→ ship at home
→ hp/shield repaired
→ others receive respawn event
```

## Golden #6 — tanker

```text
spawn
→ public visibility
→ move
→ attack
→ destruction
→ all clients converge
```

## Golden #7 — save/load

Perform save:

```text
during active game
```

restore into a fresh engine and compare:

```text
snapshot
knowledge
RNG
next command result
replay hash
```

## Golden #8 — replay

```text
seed
+ player setup
+ pre-start lifecycle
+ start
+ command sequence
→ export
→ replay
→ exact final hash
```

## Golden #9 — 4 players

Verify:

```text
bases
turn order
trap rules
elimination
victory
projection
```

## Golden #10 — event gap

Force:

```text
presentation event storm
```

and prove state event retention is independent.

---

# 25. Certification table

| Area | Verdict |
|---|---|
| Manifest syntax | PASS |
| Signature integrity | PASS |
| Engine compatibility declaration | FAIL / too broad |
| Pack loader integration | **BLOCKED** |
| Direct ruleset startup | PASS |
| 2-player gameplay | PASS |
| 3-player direct gameplay | PASS |
| 4-player direct gameplay | PASS |
| Legal-action fuzzing | PASS |
| Save/load | PASS |
| Replay | **BLOCKED by R1 engine** |
| Hidden loot projection | PASS |
| Hidden loot event privacy | **FAIL** |
| Browser module loading | **BLOCKED** |
| Public-path security | **BLOCKED by R1 engine** |
| Client event convergence | **FAIL** |
| Presentation mapping | FAIL |
| Scenario quality | WARN |
| Production certification | **BLOCKED** |

---

# 26. Final engineering verdict

### The ruleset is salvageable

There is enough evidence to say the game itself is not a rewrite candidate.

The gameplay kernel is deterministic enough to survive fuzzing and scenario execution.

### The pack is not currently deployable

The distributed pack fails the new R1 architecture at the integration boundary.

The most serious failures are:

```text
pack loader contract
browser public surface
privacy event leak
client convergence
engine path security
engine replay hashing
```

These must be repaired before calling the pack R1-compatible.

### Recommended status

```text
Last Sector 1.40.1
        ↓
       BLOCKED
        ↓
R1 migration required
        ↓
security + loader fixes
        ↓
client/event contract rebuild
        ↓
golden tests
        ↓
re-certification
```

The right next step is therefore **not** to optimize combat algorithms or micro-optimize board generation. The correct next step is to migrate Last Sector to the R1 contract and make the server/client/event/projection boundaries mechanically correct.

