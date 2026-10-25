// ARCLIGHT — offline shell.
//
// The whole game is a fixed set of static files with no backend, so the cache
// strategy is the simplest one that works: precache the shell on install, serve
// cache-first, and fall back to the network for anything not listed.
//
// BUILD is stamped with a content hash of the shipped files (server.js when
// serving, scripts/build.js for Pages), so any edit yields a new worker and a new
// cache, and activate deletes the old one — a stale build can never half-survive
// alongside a new one. Only caches with our own prefix are touched: on
// *.github.io every project shares one origin, and so one CacheStorage, with the
// other games published there.
//
// Registration is gated on a secure context in index.html, so this never runs
// when the dev server is reached over a LAN IP.

const BUILD = '16c207ee2107';
const PREFIX = 'arclight-';
const VERSION = PREFIX + BUILD;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './src/main.js',
  './src/core/config.js',
  './src/core/math.js',
  './src/core/gl.js',
  './src/core/input.js',
  './src/core/renderer.js',
  './src/gfx/post.js',
  './src/gfx/backdrop.js',
  './src/game/world.js',
  './src/game/player.js',
  './src/game/fx.js',
  './src/audio/audio.js',
  './src/ui/hud.js',
  './src/ui/screens.js',
  './src/ui/ui.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // All or nothing: a partial shell would install a worker that cannot run
      // offline. `reload` bypasses the HTTP cache so a new build never precaches
      // an old file. scripts/build.js fails if SHELL and the shipped files drift.
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch cross-origin

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Opaque and error responses are not worth storing.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() =>
        // Offline and uncached: a navigation still has to land somewhere.
        req.mode === 'navigate' ? caches.match('./index.html') : Response.error()
      );
    })
  );
});
