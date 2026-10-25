// Static build for GitHub Pages: copy the shipped files to dist/ and stamp sw.js.
// Fails if sw.js's precache list and the shipped files disagree, since a missing
// entry breaks offline play and an extra one fails the worker's install.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, shippedFiles, buildVersion, stampWorker } from './ship.js';

const OUT = path.join(ROOT, 'dist');
const files = shippedFiles();

const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']*)'/g)]
  .map((m) => m[1]).filter((f) => f && f !== 'index.html');
const want = files.filter((f) => f !== 'sw.js' && f !== 'index.html');
const missing = want.filter((f) => !shell.includes(f));
const extra = shell.filter((f) => !want.includes(f));
if (missing.length || extra.length) {
  console.error(`sw.js SHELL is out of date.\n  missing: ${missing.join(', ') || '-'}\n  extra:   ${extra.join(', ') || '-'}`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
fs.writeFileSync(path.join(OUT, 'sw.js'), stampWorker(sw));
console.log(`built dist/ (${files.length} files, sw ${buildVersion()})`);
