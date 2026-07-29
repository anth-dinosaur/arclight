import { chromium, devices } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const c = await b.newContext({...devices['iPhone 13 Pro'], viewport:{width:390,height:844}, deviceScaleFactor:2});
const p = await c.newPage();
p.on('pageerror',e=>console.log('ERR',String(e).slice(0,200)));
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(600);
await p.evaluate(()=>{ window.game.screens.hide(); window.game.state=1; });
await p.waitForTimeout(900);

const measure = async (label) => {
  const m = await p.evaluate(()=>{
    const g=window.game, gl=g.gl, t=g.post.sceneTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);
    const gw=48,gh=96, buf=new Float32Array(gw*gh*4);
    gl.readPixels(0,0,gw,gh,gl.RGBA,gl.FLOAT,buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    let sum=0,max=0,over1=0,dark=0;
    const n=gw*gh;
    for(let i=0;i<n;i++){
      const l=0.2126*buf[i*4]+0.7152*buf[i*4+1]+0.0722*buf[i*4+2];
      sum+=l; if(l>max)max=l; if(l>1)over1++; if(l<0.02)dark++;
    }
    // also read the FINAL screen
    const cv=document.createElement('canvas'); cv.width=48; cv.height=96;
    const cx=cv.getContext('2d'); cx.drawImage(document.getElementById('gl'),0,0,48,96);
    const d=cx.getImageData(0,0,48,96).data;
    let fsum=0,fmin=255,fmax=0;
    for(let i=0;i<48*96;i++){const l=0.2126*d[i*4]+0.7152*d[i*4+1]+0.0722*d[i*4+2];fsum+=l;if(l<fmin)fmin=l;if(l>fmax)fmax=l;}
    return {sceneMeanLum:+(sum/n).toFixed(4), sceneMaxLum:+max.toFixed(2),
            pctOver1:+(100*over1/n).toFixed(1), pctDark:+(100*dark/n).toFixed(1),
            finalMean:+(fsum/(48*96)).toFixed(1), finalMin:+fmin.toFixed(0), finalMax:+fmax.toFixed(0),
            layerCounts:Array.from(window.game.renderer.counts)};
  });
  console.log(label.padEnd(28), JSON.stringify(m));
};

await measure('BASELINE');
// disable backdrop
await p.evaluate(()=>{ const g=window.game; g.__bd=g.backdrop.render.bind(g.backdrop); g.backdrop.render=()=>{}; });
await p.waitForTimeout(500); await measure('no backdrop');
await p.screenshot({path:'shots/vis-nobackdrop.png'});
// restore backdrop, disable world
await p.evaluate(()=>{ const g=window.game; g.backdrop.render=g.__bd; g.__w=g.world.render.bind(g.world); g.world.render=()=>{}; });
await p.waitForTimeout(500); await measure('no world (backdrop only)');
await p.screenshot({path:'shots/vis-backdroponly.png'});
// restore all, kill bloom via exposure probe: check post with bloom off is not possible; instead measure layers
await p.evaluate(()=>{ const g=window.game; g.world.render=g.__w; });
await p.waitForTimeout(400);
// Which backdrop layer is milky? count FAR_GLOW vs SOLID contribution by nulling SOLID
await p.evaluate(()=>{ const g=window.game, r=g.renderer, o=r.flush.bind(r);
  r.flush=function(gl){ this.counts[1]=0; return o(gl); }; });
await p.waitForTimeout(500); await measure('SOLID layer suppressed');
await p.screenshot({path:'shots/vis-nosolid.png'});
await p.evaluate(()=>{ const g=window.game, r=g.renderer; r.flush=Object.getPrototypeOf(r).flush.bind(r);
  const o=r.flush; r.flush=function(gl){ this.counts[0]=0; return o(gl); }; });
await p.waitForTimeout(500); await measure('FAR_GLOW suppressed');
await p.screenshot({path:'shots/vis-nofarglow.png'});
await b.close();
