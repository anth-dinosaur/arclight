// Publish to GitHub Pages: build dist/ and force-push it to the gh-pages branch
// of the same remote as this repo (DEPLOY_REMOTE overrides the URL).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './ship.js';

const DIST = path.join(ROOT, 'dist');
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

execFileSync('node', [path.join(ROOT, 'scripts', 'build.js')], { stdio: 'inherit' });
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

const remote = process.env.DEPLOY_REMOTE || git(['remote', 'get-url', 'origin']);
const rev = git(['rev-parse', '--short', 'HEAD']);
git(['init', '-q', '-b', 'gh-pages'], DIST);
git(['add', '-A'], DIST);
git(['-c', 'user.name=' + git(['config', 'user.name']), '-c', 'user.email=' + git(['config', 'user.email']), 'commit', '-q', '-m', `Deploy ${rev}`], DIST);
execFileSync('git', ['push', '-f', remote, 'gh-pages'], { cwd: DIST, stdio: 'inherit' });
fs.rmSync(path.join(DIST, '.git'), { recursive: true, force: true });
console.log(`deployed ${rev} to gh-pages`);
