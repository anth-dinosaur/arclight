import { chromium } from 'playwright';
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const p=await (await b.newContext({viewport:{width:390,height:844}})).newPage();
p.on('console',m=>console.log(m.type().toUpperCase(),m.text().slice(0,400)));
p.on('pageerror',e=>console.log('PAGEERROR',(e.stack||e.message).slice(0,600)));
await p.goto('http://localhost:8080',{waitUntil:'networkidle'});
await p.waitForTimeout(1500);
console.log('game?',await p.evaluate(()=>typeof window.game));
await b.close();
