# Refactor Changelog — 1.40.111-R1

## Engine

- Split execution context creation into `runtime/core/context.js`.
- Split snapshot/projection/public pending logic into `runtime/core/state-view.js`.
- Added explicit synchronous callback enforcement in `runtime/core/execution.js`.
- Added iterative FIFO `runtime/core/event-dispatcher.js` with cascade budget.
- Separated state/presentation event retention windows.
- Added stream-local event cursors and global diagnostic IDs.
- Expanded replay hash coverage to authoritative runtime components.
- Added command-based `exportReplay()` and replay verification helper.
- Distribution test command is now self-contained.

## Privacy

- Card DSL projection now fails closed by default.
- Explicit `publicStatePaths` is supported.
- `legacyPublicState=true` is available only as a migration escape hatch.

## Pack lifecycle

- Pack signatures are verified before replacement.
- Pack replacement is staged with rollback to the last known good archive.
- Pack cache identity includes source SHA-256.
- Public pack files are allowlisted.
- `publicPaths` manifest field is validated.
- Server-side pack code is no longer implicitly web-public.

## Server security

- Added HMAC join tokens.
- Production match identity is authenticated unless anonymous mode is explicitly enabled.
- Match count is bounded.
- Idle match pruning is supported.
- Production automatic arbitrary match creation is disabled by default.
- Pack Manager mutation endpoints require admin token or explicit local-admin mode.
- Pack upload body size is bounded.
- WebSocket handshake/frame/message abuse limits were hardened.

## Testing

`npm test` now verifies:

- event stream isolation;
- event cascade stack safety;
- sync callback contract;
- replay reproducibility;
- privacy-safe card projection;
- staged pack install rollback;
- production match identity binding;
- scoped/expiring join tokens.

## Known remaining debt

R1 does not yet provide:

- controlled state mutation transaction API;
- side-effect transaction boundary;
- process/container sandbox for third-party packs;
- pluggable external identity provider;
- canonical event-to-viewer projection firewall;
- checkpointed long-session replay;
- per-match CPU/memory quotas.

These are Phase 2 architectural tasks.
