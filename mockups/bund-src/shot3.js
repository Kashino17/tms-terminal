const { chromium } = require(process.env.PW);
(async () => {
  const [url, out, w, h, ...steps] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: process.env.CH });
  const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2, hasTouch: false });
  p.on('pageerror', e => { if (!/TMSSim/.test(e.message)) console.log('ERR', e.message); });
  p.on('console', m => { if (m.type() === 'error' && !/TMSSim/.test(m.text())) console.log('CONSOLE', m.text()); });
  await p.goto(url); await p.waitForTimeout(800);
  for (const s of steps) {
    if (s.startsWith('LP:')) { const el = await p.$(s.slice(3)); const bx = await el.boundingBox(); await p.mouse.move(bx.x + 40, bx.y + bx.height / 2); await p.mouse.down(); await p.waitForTimeout(600); await p.mouse.up(); await p.waitForTimeout(500); continue; }
    if (s.startsWith('DRAG:')) { const [, sel, dy] = s.split('|'); const el = await p.$(sel); const bx = await el.boundingBox(); const x = bx.x + bx.width / 2, y = bx.y + bx.height / 2; await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 10; i++) { await p.mouse.move(x, y + (+dy) * i / 10); await p.waitForTimeout(16); } await p.mouse.up(); await p.waitForTimeout(500); continue; }
    if (s.startsWith('CLICK:')) { await p.click(s.slice(6)); await p.waitForTimeout(500); continue; }
    await p.evaluate(s).catch(e => console.log('step err', e.message)); await p.waitForTimeout(600);
  }
  await p.screenshot({ path: out });
  await b.close();
})();
