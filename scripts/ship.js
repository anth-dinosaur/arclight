// What the game ships: the files a browser needs, and nothing from the repo's
// docs, tools or node_modules. One list feeds the build, the content hash that
// versions the service worker, and the check that sw.js precaches all of it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOP = ['index.html', 'manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-180.png',
             'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'];

// Paths relative to ROOT, forward slashes, sorted.
export function shippedFiles() {
  const out = [...TOP];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.startsWith('.')) continue;
      const rel = `${dir}/${name}`;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('src');
  return out.sort();
}

// Content hash of everything shipped except sw.js itself, which carries it.
export function buildVersion() {
  const h = crypto.createHash('sha256');
  for (const f of shippedFiles()) {
    if (f !== 'sw.js') h.update(f).update(fs.readFileSync(path.join(ROOT, f)));
  }
  return h.digest('hex').slice(0, 12);
}

export const stampWorker = (src) => src.replace('__BUILD_VERSION__', buildVersion());
