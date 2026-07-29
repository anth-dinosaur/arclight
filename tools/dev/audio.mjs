import { chromium, devices } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required']});
const p = await (await b.newContext({...devices['iPhone 13 Pro'],viewport:{width:390,height:844}})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(700);

// Silent-play check FIRST: the game must be fully playable with audio never unlocked.
await p.evaluate(()=>{ const g=window.game; g.audio.enabled=false; g.start(); });
await p.waitForTimeout(2500);
const silent = await p.evaluate(()=>({state:window.game.state, dist:Math.round(window.game.distance),
  alive:window.game.player.alive}));
console.log('SILENT PLAY (audio never unlocked):', JSON.stringify(silent));

// Now unlock via a real gesture and inspect the graph.
await p.evaluate(()=>{ window.game.audio.enabled = true; });
await p.locator('body').click({position:{x:200,y:400}}).catch(()=>{});
await p.evaluate(async ()=>{ await window.game.audio.unlock(); });
await p.waitForTimeout(1200);

const a = await p.evaluate(()=>{
  const au = window.game.audio;
  const ctx = au.ctx || au._ctx || au.context;
  return { hasCtx: !!ctx, state: ctx?ctx.state:null, sampleRate: ctx?ctx.sampleRate:null,
           currentTime: ctx?+ctx.currentTime.toFixed(2):null, enabled: au.enabled };
});
console.log('AFTER UNLOCK:', JSON.stringify(a));

// Measure real signal by tapping the destination through an analyser.
const lvl = await p.evaluate(async ()=>{
  const au = window.game.audio;
  const ctx = au.ctx || au._ctx || au.context;
  if (!ctx) return 'no ctx';
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  // Tap whatever the module routes to destination.
  const tap = au.master || au.compressor || au._master;
  if (tap && tap.connect) tap.connect(an); else return 'no tap node';
  const buf = new Float32Array(an.fftSize);
  const samples = [];
  for (let i=0;i<24;i++){
    await new Promise(r=>setTimeout(r,120));
    an.getFloatTimeDomainData(buf);
    let peak=0, rms=0;
    for(let j=0;j<buf.length;j++){const v=Math.abs(buf[j]); if(v>peak)peak=v; rms+=buf[j]*buf[j];}
    samples.push({peak:+peak.toFixed(4), rms:+Math.sqrt(rms/buf.length).toFixed(4)});
  }
  const peaks = samples.map(s=>s.peak);
  return { maxPeak:+Math.max(...peaks).toFixed(4), avgPeak:+(peaks.reduce((x,y)=>x+y,0)/peaks.length).toFixed(4),
           nonSilentFrames: peaks.filter(v=>v>0.001).length, of: peaks.length };
});
console.log('SIGNAL AT MASTER:', JSON.stringify(lvl));

// Fire one-shots and confirm no throw / no node leak.
const shots = await p.evaluate(()=>{
  const au=window.game.audio; const before=au._voices;
  try{ for(let i=0;i<40;i++){au.perfect(i%12);au.graze();au.orb();au.attach();au.release(0.7);} }
  catch(e){ return 'THREW: '+e.message; }
  return {voicesBefore:before, voicesAfter:au._voices};
});
console.log('ONE-SHOT BURST:', JSON.stringify(shots));
console.log('ERRORS:', errs.slice(0,6));
await b.close();
