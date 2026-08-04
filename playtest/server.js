#!/usr/bin/env node
/* =============================================================================
 * No Malarkey playtest server
 *
 * Dependency-free. Node's standard library only. Three jobs:
 *
 *   1. Serve static files (the harness, and the pinned engine copy).
 *   2. GET  /api/mods       — discover mod folders (Code 1 / Code 2 pairs).
 *   3. GET  /api/mod/:name/:n — serve a mod file's raw text, never cached.
 *   4. POST /api/run        — write a result dump into runs/.
 *
 * Mod files are served with no-store + no-cache + must-revalidate and an ETag
 * built from mtime+size, so a file edit is always reflected on plain refresh.
 * You should never have to hard-reload. See README "Caching".
 *
 * This file contains NO mod-specific values. It discovers mods by looking for
 * the file-name pair; it does not know or care what is inside them.
 * ============================================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PLAYTEST_DIR = __dirname;
const PROJECT_DIR = path.resolve(PLAYTEST_DIR, '..');
const RUNS_DIR = path.join(PLAYTEST_DIR, 'runs');

// The two file names that mark a folder as a mod. Change these if the Showcase
// loader ever renames its code boxes.
const MOD_FILE_1 = 'Code 1';
const MOD_FILE_2 = 'Code 2';
const MOD_FILE_3 = 'Code 3'; // optional ENDINGS CODE; absent in most mods

// Folders never scanned for mods.
const SKIP_DIRS = new Set(['playtest', '.git', '.claude', 'node_modules', 'runs', '.DS_Store']);

const PORT = Number(process.env.PORT) || 8730;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/* ---------------------------------------------------------------- mod discovery */

function isModDir(dir) {
  try {
    return fs.statSync(path.join(dir, MOD_FILE_1)).isFile()
      && fs.statSync(path.join(dir, MOD_FILE_2)).isFile();
  } catch {
    return false;
  }
}

function describeModFile(dir, name) {
  try {
    const st = fs.statSync(path.join(dir, name));
    return { present: true, bytes: st.size, mtime: st.mtimeMs };
  } catch {
    return { present: false, bytes: 0, mtime: 0 };
  }
}

function describeMod(name, dir) {
  return {
    name,
    dir: path.relative(PROJECT_DIR, dir) || '.',
    files: {
      1: describeModFile(dir, MOD_FILE_1),
      2: describeModFile(dir, MOD_FILE_2),
      3: describeModFile(dir, MOD_FILE_3),
    },
  };
}

// Scans the project folder (the parent of playtest/) plus one level of
// subfolders. The project root itself counts as a mod if it holds the pair —
// which is how the existing files are picked up without being moved.
function discoverMods() {
  const mods = [];

  if (isModDir(PROJECT_DIR)) {
    mods.push(describeMod(path.basename(PROJECT_DIR), PROJECT_DIR));
  }

  let entries = [];
  try {
    entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  } catch {
    /* unreadable project dir; fall through with whatever we have */
  }

  for (const ent of entries) {
    if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
    const dir = path.join(PROJECT_DIR, ent.name);
    if (isModDir(dir)) mods.push(describeMod(ent.name, dir));
  }

  return mods;
}

function findModDir(name) {
  return discoverMods().find((m) => m.name === name);
}

/* ---------------------------------------------------------------- responses */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

/* ---------------------------------------------------------------- routes */

function serveModFile(req, res, modName, which) {
  const mod = findModDir(modName);
  if (!mod) return sendJson(res, 404, { error: `No mod named ${JSON.stringify(modName)}` });

  const fileName = { 1: MOD_FILE_1, 2: MOD_FILE_2, 3: MOD_FILE_3 }[which];
  if (!fileName) return sendJson(res, 400, { error: `Bad file index ${which}` });

  const abs = path.join(PROJECT_DIR, mod.dir === '.' ? '' : mod.dir, fileName);

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    // Code 3 is optional — report its absence as 204 rather than an error.
    if (which === 3) {
      res.writeHead(204, { 'Cache-Control': 'no-store, no-cache, must-revalidate' });
      return res.end();
    }
    return sendJson(res, 404, { error: `${fileName} not found in ${mod.dir}` });
  }

  // Mod files are READ ONLY as far as this server is concerned. There is no
  // route anywhere in this file that writes to them.
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return sendJson(res, 500, { error: `Could not read ${fileName}: ${err.message}` });
  }

  return sendText(res, 200, text, {
    // Belt and braces: no-store defeats the memory cache, the ETag defeats any
    // intermediary that ignores it, and the mtime/size headers let the harness
    // display exactly which bytes it is running.
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    ETag: `"${st.mtimeMs}-${st.size}"`,
    'X-Mod-Mtime': String(st.mtimeMs),
    'X-Mod-Bytes': String(st.size),
    'X-Mod-Path': path.relative(PROJECT_DIR, abs),
  });
}

function receiveRun(req, res) {
  let raw = '';
  let tooBig = false;

  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 20 * 1024 * 1024) {
      tooBig = true;
      req.destroy();
    }
  });

  req.on('end', () => {
    if (tooBig) return sendJson(res, 413, { error: 'Run dump too large (>20 MB)' });

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return sendJson(res, 400, { error: `Body was not JSON: ${err.message}` });
    }

    // Filename comes from the client but is sanitised hard: basename only,
    // safe characters only, .json enforced.
    const requested = String(payload.filename || 'run.json');
    const safe = `${path.basename(requested).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.json$/i, '')}.json`;

    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
    } catch (err) {
      return sendJson(res, 500, { error: `Could not create runs/: ${err.message}` });
    }

    const abs = path.join(RUNS_DIR, safe);
    // payload.dump is already a stable-key-order JSON string built by the
    // harness. Writing it verbatim keeps diffs clean.
    const body = typeof payload.dump === 'string'
      ? payload.dump
      : JSON.stringify(payload.dump, null, 2);

    try {
      fs.writeFileSync(abs, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
    } catch (err) {
      return sendJson(res, 500, { error: `Could not write ${safe}: ${err.message}` });
    }

    console.log(`  wrote runs/${safe}  (${Buffer.byteLength(body)} bytes)`);
    return sendJson(res, 200, {
      ok: true,
      file: `runs/${safe}`,
      absolute: abs,
      bytes: Buffer.byteLength(body),
    });
  });
}

function listRuns(res) {
  let files = [];
  try {
    files = fs.readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(RUNS_DIR, f));
        return { file: f, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    /* runs/ may not exist yet */
  }
  return sendJson(res, 200, { runs: files });
}

/* ---------------------------------------------------------------- static */

function serveStatic(req, res, pathname) {
  // Everything under playtest/ is servable. Path traversal is blocked by
  // resolving and then checking the prefix.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '') {
    // Redirect rather than serve harness/index.html directly: the page's
    // relative asset URLs (app.js, harness.css) must resolve under /harness/.
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { Location: `/harness/${qs}` });
    return res.end();
  }
  const abs = path.resolve(PLAYTEST_DIR, rel);

  if (abs !== PLAYTEST_DIR && !abs.startsWith(PLAYTEST_DIR + path.sep)) {
    return sendText(res, 403, '403 Forbidden\n');
  }

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return sendText(res, 404, `404 Not Found: ${rel}\n`);
  }

  if (st.isDirectory()) return serveStatic(req, res, `${pathname.replace(/\/$/, '')}/index.html`);

  const ext = path.extname(abs).toLowerCase();
  const isHarness = abs.startsWith(path.join(PLAYTEST_DIR, 'harness') + path.sep);

  // Harness code is no-store too, so editing the harness itself also takes
  // effect on refresh. The pinned engine is allowed to cache — it never
  // changes without a deliberate re-pin.
  const cache = isHarness
    ? 'no-store, no-cache, must-revalidate, max-age=0'
    : 'public, max-age=3600';

  const stream = fs.createReadStream(abs);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': cache,
    ETag: `"${st.mtimeMs}-${st.size}"`,
  });
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  return undefined;
}

/* ---------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/api/mods') return sendJson(res, 200, { mods: discoverMods(), projectDir: PROJECT_DIR });
  if (pathname === '/api/runs') return listRuns(res);
  if (pathname === '/api/run' && req.method === 'POST') return receiveRun(req, res);

  const modMatch = pathname.match(/^\/api\/mod\/(.+)\/([123])$/);
  if (modMatch) return serveModFile(req, res, decodeURIComponent(modMatch[1]), Number(modMatch[2]));

  return serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either the harness is already running, or something else has the port.`);
    console.error(`  Try:  PORT=8731 ./start.sh\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const mods = discoverMods();
  console.log('');
  console.log('  No Malarkey playtest harness');
  console.log('  ----------------------------');
  console.log(`  harness   http://127.0.0.1:${PORT}/`);
  console.log(`  parity    http://127.0.0.1:${PORT}/harness/parity.html`);
  console.log(`  project   ${PROJECT_DIR}`);
  console.log(`  dumps     ${RUNS_DIR}`);
  console.log('');
  if (mods.length === 0) {
    console.log(`  NO MODS FOUND. Looking for a folder containing both`);
    console.log(`  "${MOD_FILE_1}" and "${MOD_FILE_2}" in ${PROJECT_DIR}`);
    console.log(`  or in any immediate subfolder of it.`);
  } else {
    console.log(`  ${mods.length} mod${mods.length === 1 ? '' : 's'} found:`);
    for (const m of mods) {
      const k = `${(m.files[1].bytes / 1024).toFixed(0)}K + ${(m.files[2].bytes / 1024).toFixed(0)}K`;
      console.log(`    ${m.name}  (${m.dir}/)  ${k}${m.files[3].present ? ' + Code 3' : ''}`);
    }
  }
  console.log('');
  console.log('  Edit a mod file, refresh the browser. Ctrl-C to stop.');
  console.log('');
});
