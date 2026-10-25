#!/usr/bin/env node
/**
 * ARCLIGHT offline check — the installed Home Screen app must cold-launch and
 * play with no network.
 *
 * Installs the service worker, cuts the network, then reloads and opens a fresh
 * page (a cold launch) and presses LAUNCH. Also plants another app's cache first
 * and checks it survives activation: on *.github.io every project shares one
 * origin, so deleting a cache we don't own would break the other games offline.
 *
 *   node tools/offline.mjs [--url http://localhost:8080/]
 *
 * Needs a secure context, which http://localhost counts as.
 */
import { chromium, devices } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ') || true])
);
const URL_ = args.url || 'http://localhost:8080/';
const NEIGHBOUR = 'slither-cc-neighbour';

let ok = true;
const check = (name, pass, extra = '') => {
  ok &&= !!pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'], serviceWorkers: 'allow' });
const errors = [];
const watch = (p) => p.on('pageerror', (e) => errors.push(e.message));

const page = await ctx.newPage();
watch(page);
await page.goto(URL_);
await page.evaluate((n) => caches.open(n), NEIGHBOUR);

let sw;
try {
  sw = await page.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready,
      new Promise((_, r) => setTimeout(() => r(new Error('sw timeout')), 10000))]);
    const keys = await caches.keys();
    const own = keys.find((k) => k.startsWith('arclight-'));
    const cached = own ? (await (await caches.open(own)).keys()).length : 0;
    return { active: !!reg.active, keys, own, cached };
  });
} catch (e) {
  check('service worker installs', false, e.message.split('\n')[0]);
  await browser.close();
  process.exit(1);
}
check('service worker active', sw.active, `${sw.own} with ${sw.cached} entries`);
check('build hash stamped', sw.own && !sw.own.includes('__BUILD_VERSION__'), sw.own);
check("other apps' caches survive activation", sw.keys.includes(NEIGHBOUR), sw.keys.join(', '));

// Make sure the page is controlled, then cut the network.
await page.reload();
await page.waitForTimeout(500);
await ctx.setOffline(true);
await page.reload();
await page.waitForTimeout(1500);
const boot = await page.evaluate(() => ({ controlled: !!navigator.serviceWorker.controller, game: !!window.game, state: window.game?.state }));
check('reload offline', boot.controlled && boot.game && boot.state === 0, JSON.stringify(boot));

// A fresh navigation while offline — what launching from the Home Screen does.
const p2 = await ctx.newPage();
watch(p2);
await p2.goto(URL_);
await p2.waitForTimeout(1500);
await p2.getByRole('button', { name: 'LAUNCH' }).click();
await p2.waitForTimeout(1500);
const play = await p2.evaluate(() => ({ state: window.game?.state, runTime: window.game?.runTime }));
check('cold launch offline + gameplay', play.state === 1 && play.runTime > 0, JSON.stringify(play));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(ok ? '\nOFFLINE: ALL PASS' : '\nOFFLINE: FAILURES');
process.exit(ok ? 0 : 1);
