// Åbner begge versioner og fejler, hvis der er JavaScript-fejl, eller hvis overskrifterne ikke er fede.
const { chromium } = require('playwright');
const path = require('path');
const files = ['src/v1/produktionskalender.html', 'src/v2/produktionskalender-v2.html'];
(async () => {
  const b = await chromium.launch();
  let failed = false;
  for (const f of files) {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto('file://' + path.resolve(f));
    await p.waitForTimeout(400);
    if (f.includes('v2')) {
      const w = await p.$eval('h1', el => getComputedStyle(el).fontWeight);
      if (Number(w) < 700) { errs.push('h1 er ikke fed (' + w + ')'); }
    }
    console.log(errs.length ? 'FEJL ' : 'OK   ', f, errs.join('; '));
    if (errs.length) failed = true;
    await p.close();
  }
  await b.close();
  process.exit(failed ? 1 : 0);
})();
