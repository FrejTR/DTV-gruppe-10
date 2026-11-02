// Tester "Importér lager fra Rackbeat" i V2 med opdigtede tal. Kørsel: node tests/import_lager.js
const { chromium } = require('playwright');
const path = require('path');
const V2 = 'file://' + path.resolve('src/v2/produktionskalender-v2.html');
const KEY = 'kystnaer-produktionskalender-v2-onepager-i';

const FIL = { kilde: 'rackbeat', hentet: '2026-11-02T14:45', lager: { HAT003: 62, TAN001: 119, LAN002: -3, 'ANDEN-VARE': 5 } };
const asFile = data => ({ name: 'lager.json', mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });

let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(V2);
  const open = () => p.evaluate(() => { document.getElementById('sec-produkter').open = true; });
  const pick = data => p.setInputFiles('#lagerFile', asFile(data));
  const dlgText = () => p.$eval('#importBody', el => el.textContent);
  const lager = id => p.$eval('#lager-' + id, el => el.textContent);
  const heads = () => p.$$eval('#prodTbl thead th', ths => ths.map(th => th.textContent));
  await open();

  const h = await heads();
  check('kolonne 2 hedder Lager i Rackbeat', h[1].startsWith('Lager i Rackbeat'), h.join(' | '));
  check('På lager nu er væk', !h.some(t => t.includes('På lager nu')), h.join(' | '));
  check('Lager i Rackbeat står kun én gang', h.filter(t => t.startsWith('Lager i Rackbeat')).length === 1);
  check('uden import vises ikke hentet', await lager('havtorn-saebe') === '–');

  await pick(FIL);
  await p.waitForSelector('#importClose');
  check('rapport: antal opdateret', (await dlgText()).includes('opdateret for 3 produkter'), await dlgText());
  check('rapport: ikke fundet', (await dlgText()).includes('Ikke fundet i Rackbeat: HYB003'), await dlgText());
  await p.click('#importClose');
  check('tallet står direkte', await lager('havtorn-saebe') === '62' && await lager('tang-shampoo') === '119');
  check('negativt lager vises som i Rackbeat', await lager('lanolin-saebe') === '-3');
  check('produkt uden tal er urørt', await lager('hyben-saebe') === '–');
  check('sidefoden viser hentet', (await p.$eval('#rbPill', el => el.textContent)) === 'Rackbeat: lager hentet');

  await p.reload(); await open();
  check('import overlever genindlæsning', await lager('havtorn-saebe') === '62');

  for (const [navn, data] of [['ikke JSON', '{ups'], ['salgstempo-fil', { HAT003: { rate: 1 } }], ['ingen match', { ...FIL, lager: { X: 1 } }], ['decimaltal', { ...FIL, lager: { HAT003: 1.5 } }]]) {
    await pick(data);
    await p.waitForSelector('#importClose');
    check('afvises: ' + navn, (await dlgText()).includes('Intet er ændret'), await dlgText());
    await p.click('#importClose');
  }
  check('afviste filer ændrer intet', await lager('havtorn-saebe') === '62');

  await p.click('#btnReset'); await p.click('#btnResetYes');
  check('nulstil fjerner lageret', await lager('havtorn-saebe') === '–' && (await p.$eval('#rbPill', el => el.textContent)) === 'Rackbeat: ikke forbundet');

  check('ingen JavaScript-fejl', errs.length === 0, errs.join('; '));
  await b.close();
  process.exit(failed ? 1 : 0);
})();
