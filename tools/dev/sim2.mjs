// Classifies HOW runs end, across many seeds. This is the gameplay acceptance test.
import { World } from '../../src/game/world.js';
import { Player } from '../../src/game/player.js';
import { CFG } from '../../src/core/config.js';

function run(seed, botMode, seconds = 45) {
  const world = new World(seed); const player = new Player();
  player.reset(CFG.SPAWN_X, CFG.SPAWN_Y);
  let cause = null, perfects = 0, grazes = 0, orbs = 0, attaches = 0;
  const ev = {
    perfectArc: () => perfects++, graze: () => grazes++, orb: () => orbs++,
    attach: () => attaches++, release: () => {},
    crash: (x, y) => { cause = y >= CFG.FLOODLINE - 2 ? 'FLOODLINE' : 'IMPACT'; },
    reel: () => {},
  };
  const dt = 1/60;
  let phase = 0, timer = 0, t = 0;
  let seekFrames = 0, fallSeekFrames = 0, tetheredFrames = 0, frames = 0;
  let stuckFrames = 0, maxSpeed = 0;
  for (let i = 0; i < seconds * 60; i++) {
    t += dt; timer += dt;
    let down;
    if (botMode === 'hold') down = true;
    else if (botMode === 'metronome') down = (t % 0.9) < 0.65;
    else {
      if (phase === 0) { down = true; if (player.tethered) { phase = 1; timer = 0; } }
      else if (phase === 1) {
        down = true;
        const ang = Math.atan2(-player.vy, player.vx);
        if ((player.vy < -6 && player.vx > 4 && ang > 0.3 && ang < 0.9) || timer > 1.6) { down = false; phase = 2; timer = 0; }
      } else { down = false; if (timer > 0.14) { phase = 0; timer = 0; } }
    }
    player.setInput(down);
    world.update(dt, player.x, player.y);
    player.update(dt, world, ev);
    frames++;
    if (player.seeking) { seekFrames++; if (player.vy > 20) fallSeekFrames++; }
    if (player.tethered) tetheredFrames++;
    if (player.speed < 6) stuckFrames++;
    if (player.speed > maxSpeed) maxSpeed = player.speed;
    if (!player.alive) return { cause, t:+t.toFixed(1), dist:+((player.x-CFG.SPAWN_X)*0.5).toFixed(0),
      perfects, grazes, orbs, attaches, maxSpeed:+maxSpeed.toFixed(0),
      seekPct:+(100*seekFrames/frames).toFixed(0), fallSeekPct:+(100*fallSeekFrames/frames).toFixed(0),
      tethPct:+(100*tetheredFrames/frames).toFixed(0), stuckPct:+(100*stuckFrames/frames).toFixed(0) };
  }
  return { cause:'SURVIVED', t:seconds, dist:+((player.x-CFG.SPAWN_X)*0.5).toFixed(0),
    perfects, grazes, orbs, attaches, maxSpeed:+maxSpeed.toFixed(0),
    seekPct:+(100*seekFrames/frames).toFixed(0), fallSeekPct:+(100*fallSeekFrames/frames).toFixed(0),
    tethPct:+(100*tetheredFrames/frames).toFixed(0), stuckPct:+(100*stuckFrames/frames).toFixed(0) };
}

for (const bot of ['smart','metronome','hold']) {
  const rs = [];
  for (let s = 1; s <= 30; s++) rs.push(run(s, bot));
  const causes = {};
  for (const r of rs) causes[r.cause] = (causes[r.cause]||0)+1;
  const avg = k => +(rs.reduce((a,r)=>a+r[k],0)/rs.length).toFixed(1);
  const med = k => { const v=rs.map(r=>r[k]).sort((a,b)=>a-b); return v[v.length>>1]; };
  console.log(`\n=== ${bot.toUpperCase()} (30 seeds, 45s cap) ===`);
  console.log('  death causes :', JSON.stringify(causes));
  console.log(`  survival time: median ${med('t')}s  avg ${avg('t')}s`);
  console.log(`  distance     : median ${med('dist')}m  avg ${avg('dist')}m`);
  console.log(`  perfect arcs : avg ${avg('perfects')}   grazes ${avg('grazes')}  orbs ${avg('orbs')}  attaches ${avg('attaches')}`);
  console.log(`  time tethered: ${avg('tethPct')}%   seeking ${avg('seekPct')}%   seeking-while-falling ${avg('fallSeekPct')}%`);
  console.log(`  time stalled (<6 m/s): ${avg('stuckPct')}%   max speed ${avg('maxSpeed')} m/s`);
}
