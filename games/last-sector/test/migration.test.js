import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSector, lastSectorPack } from '../src/index.js';
import { createGamePack } from '@tablecore/game-pack';
import { createMatch, startMatch, dispatchMatchAction } from '@tablecore/core';

test('Last Sector is a valid current-engine Game Pack', () => {
  const pack = createGamePack(lastSectorPack);
  assert.equal(pack.manifest.id, 'last-sector');
  assert.equal(typeof pack.game.createInitialState, 'function');
  assert.equal(typeof pack.game.getPlayerView, 'function');
  assert.equal(pack.manifest.hiddenInformation, true);
});

test('Last Sector creates a deterministic private-info state without leaking seed in player view', () => {
  const a = lastSector.createInitialState({ players:['A','B'], seed:42, gridWidth:9, gridHeight:9 });
  const b = lastSector.createInitialState({ players:['A','B'], seed:42, gridWidth:9, gridHeight:9 });
  assert.deepEqual(lastSector.getPlayerView(a,'A'), lastSector.getPlayerView(b,'A'));
  assert.equal(lastSector.getPlayerView(a,'A').seed, undefined);
  assert.equal(lastSector.getPlayerView(a,'A').rngState, undefined);
});

test('Last Sector runs through the real Match lifecycle and preserves viewer projection', () => {
  const m = createMatch({ id:'ls-migration', game:lastSector, players:['A','B'], options:{seed:77,gridWidth:9,gridHeight:9} });
  const started = startMatch({match:m,game:lastSector});
  assert.equal(started.ok,true);
  const syncState = lastSector.getPlayerView(started.match.state,'A');
  assert.equal(syncState.phase,'playing');
  assert.equal(Array.isArray(syncState.tiles), true);
  const action={type:'END_TURN',actor:'A'};
  const result=dispatchMatchAction({match:started.match,game:lastSector,action});
  assert.equal(result.ok,true);
  assert.equal(result.match.version,2);
});


test('Last Sector passes current Game Pack preflight without requiring authoring bundle', async () => {
  const { lintGamePack } = await import('../../../packages/pack-linter/src/index.js');
  const { lastSectorPack, contentCatalog } = await import('../src/index.js');
  const diagnostics = lintGamePack({ pack:lastSectorPack, content:contentCatalog });
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
});
