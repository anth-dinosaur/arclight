import { chromium } from 'playwright';
const files = process.argv.slice(2);
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('http://localhost:8080/');
for (const f of files) {
  const r = await p.evaluate(async (url) => {
    const img = new Image(); img.src = url;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = Math.round(200 * img.height / img.width);
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, cv.width, cv.height);
    const d = cx.getImageData(0, 0, cv.width, cv.height).data;
    const n = cv.width * cv.height;
    const bins = new Array(10).fill(0);
    let sum = 0, sat = 0, blown = 0, rs = 0, gs = 0, bs = 0;
    for (let i = 0; i < n; i++) {
      const R = d[i*4], G = d[i*4+1], B = d[i*4+2];
      const l = 0.2126*R + 0.7152*G + 0.0722*B;
      bins[Math.min(9, Math.floor(l / 25.6))]++; sum += l;
      const mx = Math.max(R,G,B), mn = Math.min(R,G,B);
      sat += mx > 8 ? (mx-mn)/mx : 0;
      if (l > 240) blown++;
      rs += R; gs += G; bs += B;
    }
    return { meanLum:+(sum/n).toFixed(1), meanSat:+(sat/n).toFixed(3),
      pctBlownOut:+(100*blown/n).toFixed(1), pctTrueBlack:+(100*bins[0]/n).toFixed(1),
      hist:bins.map(v=>+(100*v/n).toFixed(1)), avgRGB:[Math.round(rs/n),Math.round(gs/n),Math.round(bs/n)] };
  }, 'http://localhost:8080/' + f);
  console.log(f.padEnd(26), JSON.stringify(r));
}
await b.close();
