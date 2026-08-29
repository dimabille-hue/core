import fs from 'node:fs/promises';
import path from 'node:path';

const JSON_MANIFEST = 'manifest.json';

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value);
}

export async function discoverGameCatalog({ gamesDir }) {
  const entries = await fs.readdir(gamesDir, { withFileTypes: true });
  const games = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
    const root = path.join(gamesDir, entry.name);
    const manifestPath = path.join(root, JSON_MANIFEST);
    try {
      const manifest = await readJson(manifestPath);
      if (!manifest || typeof manifest !== 'object') continue;
      if (!safeSegment(manifest.gameId) && !safeSegment(manifest.id)) continue;
      const id = manifest.gameId ?? manifest.id;
      const playIndex = manifest.playEntry ?? 'player-ui/index.html';
      const previewIndex = manifest.previewEntry ?? 'preview/index.html';
      let cover = typeof manifest.cover === 'string' ? manifest.cover : null;
      if (!cover) {
        for (const candidate of ['cover.png','cover.webp','visual-design-reference.png']) {
          if (await fileExists(path.join(root, candidate))) { cover = candidate; break; }
        }
      }
      games.push(Object.freeze({
        id,
        name: typeof manifest.name === 'string' ? manifest.name : id,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        status: typeof manifest.status === 'string' ? manifest.status : 'unknown',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        cover,
        root: entry.name,
        hasPlay: await fileExists(path.join(root, playIndex)),
        hasPreview: await fileExists(path.join(root, previewIndex)),
        playEntry: playIndex,
        previewEntry: previewIndex,
      }));
    } catch {
      // Ignore folders that are not complete Game Packs. The catalog should
      // remain usable even when a third-party pack is currently being copied.
    }
  }
  return games.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function fileExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
