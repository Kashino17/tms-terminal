const { chromium } = require(process.env.PW);
(async () => {
  const [url, out, w, h, h2, ...steps] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: process.env.CH });
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
  await p.goto(url); await p.waitForTimeout(800);
  for (const s of steps) { await p.evaluate(s).catch(e => console.log('step err', e.message)); await p.waitForTimeout(600); }
  if (+h2 && +h2 !== +h) { await p.setViewportSize({ width: +w, height: +h2 }); await p.waitForTimeout(800); }
  await p.screenshot({ path: out });
  await b.close();
})();
