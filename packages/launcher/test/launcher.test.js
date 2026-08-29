import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverGameCatalog } from '../src/index.js';
import { createLauncherServer } from '../../../tools/launcher/server.mjs';

test('launcher discovers complete manifests and flags play/preview capability', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-'));
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'preview'), { recursive: true });
    await fs.mkdir(path.join(root, 'broken'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0', description:'Demo' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'preview', 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'broken', 'manifest.json'), '{not-json');
    const games = await discoverGameCatalog({ gamesDir: path.join(root, 'games') });
    assert.equal(games.length, 1);
    assert.deepEqual({ id:games[0].id, name:games[0].name, hasPlay:games[0].hasPlay, hasPreview:games[0].hasPreview }, { id:'alpha', name:'Alpha', hasPlay:true, hasPreview:true });
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('launcher rejects path-unsafe manifest IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-'));
  try {
    await fs.mkdir(path.join(root, 'unsafe'), { recursive: true });
    await fs.writeFile(path.join(root, 'unsafe', 'manifest.json'), JSON.stringify({id:'../escape',name:'Escape'}));
    const games = await discoverGameCatalog({ gamesDir: root });
    assert.equal(games.length, 0);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('launcher serves catalog and redirects play/preview without exposing filesystem paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-http-'));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'preview'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), 'PLAY');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'preview', 'index.html'), 'PREVIEW');
    await fs.mkdir(path.join(root, 'packages/launcher/public'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/launcher/public/index.html'), '<!doctype html>');
    const address=await launcher.listen();
    const base=`http://127.0.0.1:${address.port}`;
    const catalog=await fetch(`${base}/api/games`).then(r=>r.json());
    assert.equal(catalog.games.length,1);
    const play=await fetch(`${base}/play/alpha`,{redirect:'manual'}); assert.equal(play.status,302); assert.equal(play.headers.get('location'),'/games/alpha/player-ui/index.html');
    const preview=await fetch(`${base}/preview/alpha`,{redirect:'manual'}); assert.equal(preview.status,302); assert.equal(preview.headers.get('location'),'/games/alpha/preview/index.html');
    const file=await fetch(`${base}/games/alpha/player-ui/index.html`).then(r=>r.text()); assert.equal(file,'PLAY');
    const traversal=await fetch(`${base}/games/alpha/%2e%2e/%2e%2e/package.json`); assert.equal(traversal.status,404);
  } finally { await launcher.close(); await fs.rm(root,{recursive:true,force:true}); }
});

// Regression test (found and fixed while independently reviewing this
// launcher patch, not part of its own test suite): the original version
// resolved `/games/<root>/<anything>` against nothing more than a path-
// containment check ("does the resolved path stay inside games/<root>?"),
// which is a traversal guard, not a public-surface allowlist. Confirmed
// directly: it served arbitrary files under a cataloged game's directory
// -- source code, test files, internal notes, anything -- as long as the
// path merely stayed inside that game's own folder. Only `player-ui/`,
// `preview/`, `tv-ui/`, and the exact declared `cover` file are meant to
// ever be fetched by a browser; this is the same "declare what's public,
// deny by default" allowlist principle already used elsewhere in this
// project's history for served pack content.
test('launcher never serves files outside the public player-ui/preview/tv-ui/cover surface, even without any path traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tablecore-launcher-surface-'));
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    await fs.mkdir(path.join(root, 'games', 'alpha', 'player-ui'), { recursive: true });
    await fs.mkdir(path.join(root, 'games', 'alpha', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'alpha', 'manifest.json'), JSON.stringify({ id:'alpha', name:'Alpha', version:'1.0.0', cover:'cover.png' }));
    await fs.writeFile(path.join(root, 'games', 'alpha', 'player-ui', 'index.html'), 'PLAY');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'src', 'game.js'), 'export const secret = 1;');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'internal-notes.md'), 'do not ship this');
    await fs.writeFile(path.join(root, 'games', 'alpha', 'cover.png'), 'not-a-real-png-but-fine-for-this-test');
    await fs.mkdir(path.join(root, 'packages/launcher/public'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/launcher/public/index.html'), '<!doctype html>');
    const address=await launcher.listen();
    const base=`http://127.0.0.1:${address.port}`;

    const source=await fetch(`${base}/games/alpha/src/game.js`); assert.equal(source.status,404,'rule/server source code must never be served');
    const notes=await fetch(`${base}/games/alpha/internal-notes.md`); assert.equal(notes.status,404,'arbitrary top-level files must never be served');
    const manifest=await fetch(`${base}/games/alpha/manifest.json`); assert.equal(manifest.status,404,'manifest.json itself is not on the public allowlist');
    const cover=await fetch(`${base}/games/alpha/cover.png`); assert.equal(cover.status,200,'the exact declared cover file IS public');
    const ui=await fetch(`${base}/games/alpha/player-ui/index.html`); assert.equal(ui.status,200,'player-ui/ contents remain public');

    // Requesting a path under a game folder name that isn't in the
    // discovered catalog at all (e.g. a folder that failed manifest
    // validation) must not be servable either -- catalog membership is
    // required, not just "some directory exists on disk under games/".
    await fs.mkdir(path.join(root, 'games', 'not-a-real-pack', 'player-ui'), { recursive: true });
    await fs.writeFile(path.join(root, 'games', 'not-a-real-pack', 'player-ui', 'index.html'), 'should not be reachable');
    const uncataloged=await fetch(`${base}/games/not-a-real-pack/player-ui/index.html`);
    assert.equal(uncataloged.status,404,'a folder under games/ with no valid manifest must not be servable even under an otherwise-public-looking path');
  } finally { await launcher.close(); await fs.rm(root,{recursive:true,force:true}); }
});

// Real-repository integration test: the actual games/ directory in this
// checkout, not a synthetic temp fixture. Proves the stated requirement
// ("installed games should be picked up automatically") against the real
// filesystem layout, and documents the honest current state: only
// last-sector has an actual player UI today (the four engine reference/
// demo games -- grid-duel, coin-race, phase-quest, sector-expedition --
// were built purely as backend rules-testing fixtures throughout this
// project's history and never got a player-facing UI), which the
// launcher correctly reflects rather than hides.
test('real repository: all real games under games/ are auto-discovered, test fixtures are not, last-sector is the only currently-playable one', async () => {
  const gamesDir = new URL('../../../games', import.meta.url).pathname;
  const games = await discoverGameCatalog({ gamesDir });
  const ids = games.map(g => g.id).sort();
  assert.deepEqual(ids, ['coin-race', 'grid-duel', 'last-sector', 'phase-quest', 'sector-expedition'], 'all five real games auto-discovered, none of the three worker-pool test fixtures (timebomb-test/memory-hog-test/infinite-loop-test, which have no manifest.json) show up');
  const lastSector = games.find(g => g.id === 'last-sector');
  assert.equal(lastSector.hasPlay, true);
  assert.equal(lastSector.hasPreview, true);
  for (const id of ['coin-race', 'grid-duel', 'phase-quest', 'sector-expedition']) {
    const g = games.find(x => x.id === id);
    assert.equal(g.hasPlay, false, `${id} has no player-ui/ directory yet -- this is accurate, not a launcher bug`);
  }
});

test('real repository, real HTTP server: the whole catalog->play->page flow works end-to-end, and source code is not exposed', async () => {
  const root = new URL('../../..', import.meta.url).pathname;
  const launcher = createLauncherServer({ root, host:'127.0.0.1', port:0 });
  try {
    const address = await launcher.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const catalog = await fetch(`${base}/api/games`).then(r => r.json());
    assert.ok(catalog.games.length >= 5);
    const play = await fetch(`${base}/play/last-sector`, { redirect: 'manual' });
    assert.equal(play.status, 302);
    const page = await fetch(`${base}${play.headers.get('location')}`);
    assert.equal(page.status, 200);
    const leak = await fetch(`${base}/games/last-sector/src/game.js`);
    assert.equal(leak.status, 404, 'Last Sector\'s actual rule source code must not be servable over HTTP by the launcher');
  } finally { await launcher.close(); }
});
