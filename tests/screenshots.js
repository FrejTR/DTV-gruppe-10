// Skærmbilleder af V2 på computer og iPad Mini til rapporten. Output: tests/out/
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
(async () => {
  fs.mkdirSync('tests/out', { recursive: true });
  const b = await chromium.launch();
  for (const [w, n] of [[1280, 'desktop'], [744, 'ipad']]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    await p.goto('file://' + path.resolve('src/v2/produktionskalender-v2.html'));
    await p.waitForTimeout(400);
    await p.screenshot({ path: `tests/out/v2-${n}.png`, fullPage: true });
    await p.close();
  }
  await b.close();
})();
