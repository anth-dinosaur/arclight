import { chromium, devices } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const c = await b.newContext({...devices['iPhone 13 Pro'], viewport:{width:390,height:844}, deviceScaleFactor:2});
const p = await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(800);
const out = await p.evaluate(()=>{
  const g=window.game, gl=g.gl, r=g.renderer;
  // Capture what one frame submits, per layer.
  const layerInfo=[];
  for(let L=0;L<4;L++){
    const n=r.counts[L], a=r.data[L], s=[];
    for(let i=0;i<Math.min(n,4);i++){
      const o=i*16;
      s.push({x:+a[o].toFixed(1),y:+a[o+1].toFixed(1),hw:+a[o+2].toFixed(1),hh:+a[o+3].toFixed(1),
              shape:a[o+5],plx:+a[o+7].toFixed(2),
              col:[+a[o+8].toFixed(2),+a[o+9].toFixed(2),+a[o+10].toFixed(2),+a[o+11].toFixed(2)],
              glow:+a[o+12].toFixed(2)});
    }
    layerInfo.push({layer:L,count:n,sample:s});
  }
  // Read back the centre of the HDR scene target.
  const t=g.post.sceneTarget;
  const px=new Float32Array(4);
  let sceneCentre=null, sceneMax=0;
  try{
    gl.bindFramebuffer(gl.FRAMEBUFFER,t.fbo);
    const buf=new Float32Array(4);
    gl.readPixels((t.w/2)|0,(t.h/2)|0,1,1,gl.RGBA,gl.FLOAT,buf);
    sceneCentre=Array.from(buf).map(v=>+v.toFixed(3));
    // sample a grid for max luminance
    const gw=32,gh=64,grid=new Float32Array(gw*gh*4);
    gl.readPixels(0,0,gw,gh,gl.RGBA,gl.FLOAT,grid);
    for(let i=0;i<gw*gh;i++) sceneMax=Math.max(sceneMax,grid[i*4],grid[i*4+1],grid[i*4+2]);
  }catch(e){ sceneCentre='readpixels failed: '+e.message; }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  return {
    state:g.state, cam:{x:+g.camX.toFixed(1),y:+g.camY.toFixed(1)}, zoom:+g.zoom.toFixed(2),
    baseZoom:+g.baseZoom.toFixed(2), quality:g.quality, viewW:g.viewW, viewH:g.viewH,
    targetSize:{w:t.w,h:t.h}, hasBindFn:typeof t.bind,
    player:{x:+g.player.x.toFixed(1),y:+g.player.y.toFixed(1),alive:g.player.alive},
    worldCounts:{anchors:g.world.anchors.length,hazards:g.world.hazards.length,orbs:g.world.orbs.length,solids:g.world.solids.length},
    layerInfo, sceneCentre, sceneMax:+sceneMax.toFixed(3),
    glErr:gl.getError(),
  };
});
console.log(JSON.stringify(out,null,1));
console.log('ERRORS:',errs.slice(0,10));
await b.close();
