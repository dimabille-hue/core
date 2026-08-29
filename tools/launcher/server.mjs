import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverGameCatalog } from '../../packages/launcher/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function redirect(res,location){res.writeHead(302,{location});res.end();}
function safePath(base,relative){
  const abs=path.resolve(base,relative);
  if(abs!==base && !abs.startsWith(base+path.sep)) return null;
  return abs;
}
function contentType(file){const ext=path.extname(file).toLowerCase();return {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon'}[ext]||'application/octet-stream';}
async function sendFile(res,file){
  if(!file){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return void res.end('Not found');}
  try{const stat=await fs.stat(file);if(!stat.isFile())throw new Error('not-file');res.writeHead(200,{'content-type':contentType(file),'cache-control':'no-cache'});res.end(await fs.readFile(file));}
  catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found');}
}

// A game's directory on disk is NOT the same thing as its public surface.
// `games/<id>/` typically also contains `src/` (rule/server logic),
// `test/` (which can contain internal comments about known weaknesses --
// see this very engine's own audit history for examples of test files
// documenting exactly that), authoring bundles, migration/audit
// markdown, etc. The original version of this launcher resolved
// `/games/<root>/<anything>` against nothing more than a path-
// containment check ("does it stay inside games/<root>?") -- which is a
// traversal guard, not a public-surface allowlist. Verified directly: it
// served arbitrary non-UI files (source code, internal notes) over HTTP
// for any path that merely stayed inside a cataloged game's folder. Only
// `player-ui/`, `preview/`, `tv-ui/`, and the exact declared `cover`
// image are ever legitimately meant to be fetched by a browser (they are
// the only paths the launcher's own UI, or a pack's own player-ui/
// preview/tv-ui pages, ever construct URLs for) -- this is the same
// "declare what's public, deny everything else by default" principle
// already used elsewhere in this project's history (an earlier engine's
// PACK_SECURITY model had an equivalent `publicPaths`-style allowlist for
// exactly this reason).
const PUBLIC_GAME_PREFIXES = ['player-ui', 'preview', 'tv-ui'];
function isPublicGamePath(game, relativeSegments) {
  const normalized = relativeSegments.filter(Boolean).join('/');
  if (!normalized) return false;
  if (game.cover && normalized === game.cover) return true;
  return PUBLIC_GAME_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'));
}

export function createLauncherServer({ root = ROOT, host = process.env.TABLECORE_LAUNCHER_HOST || '127.0.0.1', port = Number(process.env.TABLECORE_LAUNCHER_PORT || 4170) } = {}) {
  const gamesDir = path.resolve(root, 'games');
  const publicDir = path.resolve(root, 'packages/launcher/public');
  const server = http.createServer(async (req,res)=>{
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/api/games') return json(res,200,{games:await discoverGameCatalog({gamesDir})});
      if (url.pathname.startsWith('/play/') || url.pathname.startsWith('/preview/')) {
        const parts=url.pathname.split('/').filter(Boolean);
        const mode=parts[0];
        const id=decodeURIComponent(parts.slice(1).join('/'));
        const game=(await discoverGameCatalog({gamesDir})).find(g=>g.id===id);
        if(!game) return json(res,404,{error:'GAME_NOT_FOUND'});
        const entry=mode==='play'?game.playEntry:game.previewEntry;
        const available=mode==='play'?game.hasPlay:game.hasPreview;
        if(!available) return json(res,404,{error:mode==='play'?'PLAY_UNAVAILABLE':'PREVIEW_UNAVAILABLE'});
        const location=`/games/${encodeURIComponent(game.root)}/${entry.split('/').map(encodeURIComponent).join('/')}`;
        return redirect(res,location);
      }
      if(url.pathname.startsWith('/launcher/')) {
        const rel=decodeURIComponent(url.pathname.slice('/launcher/'.length)) || 'index.html';
        return sendFile(res,safePath(publicDir,rel));
      }
      if(url.pathname.startsWith('/games/')) {
        const rel=url.pathname.slice('/games/'.length).split('/');
        if(rel.length<2) return sendFile(res,null);
        const rootName=decodeURIComponent(rel.shift());
        const relativeSegments=rel.map(decodeURIComponent);
        // Only serve files belonging to a game that actually appears in
        // the discovered catalog (real manifest, safe id) -- not merely
        // "any folder name under games/". Then require the requested
        // path to fall under the public-surface allowlist above.
        // safePath()'s containment check still runs too, as defense in
        // depth against a rootName/relative path that somehow encodes a
        // traversal sequence -- but the allowlist is the actual boundary
        // now, not just "did you escape the games/ directory".
        const game=(await discoverGameCatalog({gamesDir})).find(g=>g.root===rootName);
        if(!game || !isPublicGamePath(game, relativeSegments)) return sendFile(res,null);
        return sendFile(res,safePath(gamesDir,path.join(rootName,relativeSegments.join('/'))));
      }
      if(url.pathname==='/') return sendFile(res,path.join(publicDir,'index.html'));
      if(url.pathname==='/style.css'||url.pathname==='/launcher.css') return sendFile(res,path.join(publicDir,'style.css'));
      return json(res,404,{error:'NOT_FOUND'});
    } catch { return json(res,500,{error:'LAUNCHER_ERROR'}); }
  });
  return { server, host, port, async listen() { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}); return server.address();}, async close() { await new Promise(resolve=>server.close(()=>resolve())); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const launcher=createLauncherServer();
  launcher.listen().then(address=>console.log(`TableCore Launcher: http://${address.address}:${address.port}`)).catch(error=>{console.error(error);process.exitCode=1;});
  const stop=()=>launcher.close().finally(()=>process.exit(0));
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
}
