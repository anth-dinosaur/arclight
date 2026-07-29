// Headless gameplay sim: no browser, no renderer. Finds out why runs end.
import { World } from '../../src/game/world.js';
import { Player } from '../../src/game/player.js';
import { CFG } from '../../src/core/config.js';

function run(seed, botMode, seconds = 30, verbose = false) {
  const world = new World(seed);
  const player = new Player();
  player.reset(20, -14);
  const log = [];
  const ev = {
    perfectArc: (x,y,q) => log.push({t:'perfect', q:+q.toFixed(2)}),
    graze: () => log.push({t:'graze'}),
    orb: () => log.push({t:'orb'}),
    attach: (x,y) => log.push({t:'attach', x:+x.toFixed(1), y:+y.toFixed(1)}),
    release: () => log.push({t:'release'}),
    crash: (x,y,vx,vy) => log.push({t:'crash', x:+x.toFixed(1), y:+y.toFixed(1),
                                    vx:+vx.toFixed(1), vy:+vy.toFixed(1)}),
    reel: () => {},
  };

  const dt = 1/60;
  let phase = 0, timer = 0, t = 0;
  const trace = [];
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
        if ((player.vy < -6 && player.vx > 4 && ang > 0.3 && ang < 0.9) || timer > 1.6) {
          down = false; phase = 2; timer = 0;
        }
      } else { down = false; if (timer > 0.14) { phase = 0; timer = 0; } }
    }
    player.setInput(down);
    world.update(dt, player.x, player.y);
    player.update(dt, world, ev);
    if (i % 30 === 0) trace.push({t:+t.toFixed(1), x:+player.x.toFixed(1), y:+player.y.toFixed(1),
      sp:+player.speed.toFixed(1), teth:player.tethered, seek:!!player.seeking});
    if (!player.alive) {
      return { died: true, atTime:+t.toFixed(2), dist:+((player.x-20)*0.5).toFixed(1),
               x:+player.x.toFixed(1), y:+player.y.toFixed(1),
               floodline: player.y >= CFG.FLOODLINE,
               log: log.slice(-8), trace: verbose ? trace : trace.slice(-6) };
    }
  }
  const counts = {};
  for (const e of log) counts[e.t] = (counts[e.t]||0)+1;
  return { died:false, dist:+((player.x-20)*0.5).toFixed(1), sp:+player.speed.toFixed(1),
           counts, trace: verbose ? trace : trace.slice(-4) };
}

for (const bot of ['smart','metronome','hold']) {
  console.log('\n=== BOT:', bot, '===');
  for (const seed of [1, 7, 12345]) {
    const r = run(seed, bot, 30, bot==='smart' && seed===1);
    console.log('seed', seed, JSON.stringify(r).slice(0, 1400));
  }
}
