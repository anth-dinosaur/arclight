import { chromium, devices } from 'playwright';
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const p=await (await b.newContext({...devices['iPhone 13 Pro'],viewport:{width:390,height:844},deviceScaleFactor:2})).newPage();
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(700);
await p.evaluate(()=>{window.game.start();});
// let the bot fly a bit
await p.evaluate(()=>{const g=window.game;let ph=0,tm=0;const s=()=>{tm+=1/60;
  if(ph===0){g.input.down=true;if(g.player.tethered){ph=1;tm=0;}}
  else if(ph===1){const a=Math.atan2(-g.player.vy,g.player.vx);
    if((g.player.vy<-6&&g.player.vx>4&&a>0.3&&a<0.9)||tm>1.6){g.input.down=false;ph=2;tm=0;}}
  else if(tm>0.14){ph=0;tm=0;}
  if(g.state===3)g.start(); setTimeout(s,16);};s();});
await p.waitForTimeout(6000);
const h = await p.evaluate(()=>{
  const c=document.getElementById('gl');
  const cv=document.createElement('canvas');cv.width=195;cv.height=422;
  const cx=cv.getContext('2d');cx.drawImage(c,0,0,195,422);
  const d=cx.getImageData(0,0,195,422).data;const n=195*422;
  const bins=new Array(10).fill(0);let sum=0,sat=0,blown=0;
  let rs=0,gs=0,bs=0;
  for(let i=0;i<n;i++){
    const r=d[i*4],g=d[i*4+1],bl=d[i*4+2];
    const l=0.2126*r+0.7152*g+0.0722*bl;
    bins[Math.min(9,Math.floor(l/25.6))]++;sum+=l;
    const mx=Math.max(r,g,bl),mn=Math.min(r,g,bl);
    sat+=mx>0?(mx-mn)/mx:0;
    if(l>245)blown++;
    rs+=r;gs+=g;bs+=bl;
  }
  return {meanLum:+(sum/n).toFixed(1), meanSat:+(sat/n).toFixed(3),
    pctBlownOut:+(100*blown/n).toFixed(1),
    pctBelow10:+(100*bins[0]/n).toFixed(1),
    histogram:bins.map(v=>+(100*v/n).toFixed(1)),
    avgRGB:[Math.round(rs/n),Math.round(gs/n),Math.round(bs/n)]};
});
console.log(JSON.stringify(h,null,1));
await b.close();
