import { World } from '../../src/game/world.js';
import { Player } from '../../src/game/player.js';
import { CFG } from '../../src/core/config.js';
import { circleVsOBB, dist } from '../../src/core/math.js';

console.log('CFG: TETHER_MAX_RANGE',CFG.TETHER_MAX_RANGE,'CONE',CFG.TETHER_CONE,'TUTORIAL_DIST',CFG.TUTORIAL_DIST);
for (const seed of [1,7,12345,999,42]) {
  const w = new World(seed);
  w.update(1/60, 20, -14);
  const A = w.anchors, S = w.solids, H = w.hazards;
  // anchors near spawn
  const near = A.map(a=>({x:+a.x.toFixed(1),y:+a.y.toFixed(1),d:+dist(20,-14,a.x,a.y).toFixed(1)}))
                .filter(a=>a.d < 40).sort((p,q)=>p.d-q.d).slice(0,5);
  // solids overlapping spawn
  const hit = S.filter(o=>circleVsOBB(20,-14,CFG.PLAYER_RADIUS+1.5,o.x,o.y,o.hw,o.hh,o.rot||0))
               .map(o=>({x:+o.x.toFixed(1),y:+o.y.toFixed(1),hw:o.hw,hh:o.hh}));
  const inRange = near.filter(a=>a.d>=CFG.TETHER_MIN_RANGE && a.d<=CFG.TETHER_MAX_RANGE);
  console.log(`\nseed ${seed}: anchors=${A.length} solids=${S.length} hazards=${H.length}`);
  console.log('  nearest anchors:', JSON.stringify(near));
  console.log('  IN TETHER RANGE:', inRange.length, JSON.stringify(inRange));
  console.log('  SOLIDS OVERLAPPING SPAWN:', hit.length, JSON.stringify(hit));
}

// How often does a straight-chord-cleared solid actually sit in the ballistic sag?
let sag=0, tot=0;
for (let seed=1; seed<=25; seed++){
  const w=new World(seed); w.update(1/60,20,-14);
  const A=[...w.anchors].sort((a,b)=>a.x-b.x), S=w.solids;
  for(let i=0;i<A.length-1;i++){
    const a=A[i],b=A[i+1]; if(b.x-a.x>60) continue; tot++;
    // sample a sagging parabola between the two anchors
    for(let s=1;s<10;s++){
      const t=s/10, px=a.x+(b.x-a.x)*t, py=a.y+(b.y-a.y)*t + 10*Math.sin(t*Math.PI);
      if(S.some(o=>circleVsOBB(px,py,CFG.PLAYER_RADIUS,o.x,o.y,o.hw,o.hh,o.rot||0))){sag++;break;}
    }
  }
}
console.log(`\nBALLISTIC-SAG COLLISIONS: ${sag}/${tot} anchor spans (${(100*sag/tot).toFixed(1)}%) have a solid in the sag path`);
