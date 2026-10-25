#!/usr/bin/env node
// ARCLIGHT static server. Binds 0.0.0.0 so phones on the LAN can reach it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { stampWorker } from './scripts/ship.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// `no-store` on everything was simple but wrong once there is a service worker:
// it is the one directive that forbids storing a response at all, which is
// hostile to the offline shell and pointless for assets that never change
// during a session. `no-cache` still forces a revalidation on every request —
// so edits show up on the next reload exactly as before — while letting the
// browser and the SW keep a copy.
const CACHE_IMMUTABLE = 'public, max-age=3600';
const CACHE_REVALIDATE = 'no-cache';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Contain the resolved path inside ROOT — reject any traversal attempt.
    const target = resolve(join(ROOT, normalize(path)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target);
    if (info.isDirectory()) { res.writeHead(404).end('Not found'); return; }

    const ext = extname(target).toLowerCase();
    let body = await readFile(target);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      // Icons are the only thing here that is not edited during development.
      'Cache-Control': (ext === '.png' || ext === '.svg' || ext === '.ico')
        ? CACHE_IMMUTABLE
        : CACHE_REVALIDATE,
      'Cross-Origin-Opener-Policy': 'same-origin',
    };
    // A stale service worker outlives a reload; it must never be served from cache.
    if (path.endsWith('/sw.js')) {
      // Stamp the content hash so an edit anywhere installs a fresh worker + cache.
      body = Buffer.from(stampWorker(body.toString()));
      headers['Content-Length'] = body.length;
      headers['Cache-Control'] = 'no-cache';
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
    }
  }
});

server.listen(PORT, HOST, () => {
  const addrs = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log(`\n  ARCLIGHT serving ${ROOT}`);
  console.log(`  local    http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  network  http://${a}:${PORT}`);
  console.log('');
});
