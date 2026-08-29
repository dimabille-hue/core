#!/usr/bin/env node
// Generates games/<name>/manifest.json from each game pack's OWN runtime
// manifest object (the one createGamePack() actually validates), rather
// than hand-maintaining a second, independent copy that can silently
// drift out of sync -- exactly the class of bug found and fixed several
// times elsewhere in this project's history (replay.gameVersion,
// pack-linter's authoring==null handling, and Last Sector's own
// engineCompatibility field being present in manifest.json but missing
// from its runtime manifest object until that was found and fixed).
//
// This intentionally IS a build-time script that imports pack code --
// unlike the launcher server itself (tools/launcher/server.mjs), which
// deliberately never imports/executes a game pack merely to build its
// catalog (see catalog.js's own module doc comment for why that
// distinction matters: a build step run by a repo maintainer against
// packs they already trust is a different trust boundary than a live
// server discovering whatever happens to be dropped into games/).
//
// Run: node tools/launcher/generate-manifests.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const GAMES_ROOT = new URL('../../games/', import.meta.url);

const specs = [
  { dir: 'coin-race', packageName: '@tablecore/game-coin-race', exportName: 'coinRacePack' },
  { dir: 'phase-quest', packageName: '@tablecore/game-phase-quest', exportName: 'phaseQuestPack' },
  { dir: 'sector-expedition', packageName: '@tablecore/game-sector-expedition', exportName: 'sectorExpeditionPack' },
  // last-sector deliberately excluded: it already has a hand-maintained
  // manifest.json with real fields nothing else in this generator knows
  // about (engineCompatibility, capabilities, entry, content, ...) --
  // blindly regenerating it here would silently destroy them. Nothing in
  // this codebase currently reads games/last-sector/manifest.json except
  // this launcher, so there is no live drift risk from leaving it alone;
  // if last-sector's runtime manifest ever changes in a way that should
  // be reflected here, that is a deliberate, reviewed edit to the
  // existing file, not something to auto-overwrite.
];

for (const spec of specs) {
  const mod = await import(spec.packageName);
  const pack = mod[spec.exportName];
  if (!pack || !pack.manifest) throw new Error(`${spec.packageName}: no ${spec.exportName}.manifest found`);
  // Full mirror of the pack's own runtime manifest, not a curated
  // subset: the launcher's catalog.js only reads a few fields today, but
  // a curated subset is exactly how last-sector's manifest.json and its
  // runtime manifest object drifted apart before (engineCompatibility
  // present in one, missing from the other) -- mirroring everything
  // means there is nothing THIS script could omit that could later
  // silently diverge.
  const manifest = { ...pack.manifest, status: 'preview' };
  const path = fileURLToPath(new URL(`${spec.dir}/manifest.json`, GAMES_ROOT));
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${path}`);
}
