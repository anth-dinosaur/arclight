import { chromium, devices } from 'playwright';
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const p=await (await b.newContext({...devices['iPhone 13 Pro'],viewport:{width:390,height:844}})).newPage();
p.on('pageerror',e=>console.log('PAGEERROR',String(e).slice(0,300)));
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(800);
const probe = () => p.evaluate(()=>{
  const s=document.getElementById('screens');
  const vis=[...s.querySelectorAll('*')].filter(e=>{
    const c=getComputedStyle(e); return c.opacity!=='0'&&c.display!=='none'&&c.visibility!=='hidden'&&e.offsetWidth>0;
  });
  const over=s.querySelector('.scr--over'), title=s.querySelector('.scr--title');
  const st=e=>e?{op:getComputedStyle(e).opacity,disp:getComputedStyle(e).display,cls:e.className}:null;
  return {gameState:window.game.state, screensVisible:window.game.screens.visible,
          title:st(title), over:st(over), visCount:vis.length};
});
console.log('after boot      ', JSON.stringify(await probe()));
await p.evaluate(()=>window.game.start());
await p.waitForTimeout(700);
console.log('after start()   ', JSON.stringify(await probe()));
await p.evaluate(()=>{const g=window.game; g.die(g.player.x,g.player.y,0,0);});
await p.waitForTimeout(1800);
console.log('after death     ', JSON.stringify(await probe()));
await p.evaluate(()=>window.game.start());
await p.waitForTimeout(700);
console.log('after restart   ', JSON.stringify(await probe()));
await p.waitForTimeout(1500);
console.log('1.5s later      ', JSON.stringify(await probe()));
await p.screenshot({path:'shots/screens-after-restart.png'});
await b.close();
