// Tester "Importér salgstempo" i V2 med opdigtede tal. Kørsel: node tests/import_salgstempo.js
const { chromium } = require('playwright');
const path = require('path');
const V2 = 'file://' + path.resolve('src/v2/produktionskalender-v2.html');
const KEY = 'kystnaer-produktionskalender-v2-onepager-i';
const OLD_KEY = 'kystnaer-produktionskalender-v2-onepager-h';

const post = (rate, extra) => ({ rate, maanedlig: Array(12).fill(rate), seneste8: rate + 1, beregnet: '2026-11-02', vindue_uger: 52, sikkerhed: 'middel', flag: [], ...extra });
const FIL = { 'KN-1001': post(12.4), 'KN-1002': post(30.25, { flag: ['muligt_udsolgt', '<img src=x onerror=alert(1)>'] }), 'KN-9999': post(3) };
const asFile = data => ({ name: 'salgstempo.json', mimeType: 'application/json', buffer: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });

let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(V2);
  const state = () => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const rate = sku => p.evaluate(([k, s]) => { const d = JSON.parse(localStorage.getItem(k)); return d && d.products.find(x => x.sku === s).rate; }, [KEY, sku]);
  const inputRate = id => p.$eval('#rate-' + id, el => el.value);
  const pick = data => p.setInputFiles('#importFile', asFile(data));
  const dlgText = () => p.$eval('#importBody', el => el.textContent);
  await p.evaluate(() => { document.getElementById('sec-produkter').open = true; });

  check('uden import vises Estimat', (await p.$eval('#p-produkter', el => el.textContent)).includes('Estimat'));
  check('knappen står i sidefoden', await p.$('.footer #btnImport') !== null);

  // Annullér ændrer intet
  await pick(FIL);
  await p.waitForSelector('#importYes');
  check('intet ændres før bekræftelse', await inputRate('havtorn-saebe') === '20');
  check('bekræftelsen viser ændringen', (await dlgText()).includes('20 → 12,4'), await dlgText());
  check('bekræftelsen viser ukendt SKU', (await dlgText()).includes('KN-9999'));
  await p.click('#importNo');
  check('annullér ændrer intet', await inputRate('havtorn-saebe') === '20');

  // Bekræft
  await pick(FIL);
  await p.waitForSelector('#importYes');
  await p.click('#importYes');
  check('rapport: antal opdateret', (await dlgText()).includes('2 produkter opdateret'), await dlgText());
  check('rapport: ikke fundet', (await dlgText()).includes('KN-9999'));
  await p.click('#importClose');
  check('rate er sat', await inputRate('havtorn-saebe') === '12.4' && await rate('KN-1001') === 12.4);
  const s = await state();
  const pr = s.products.find(x => x.sku === 'KN-1001');
  check('kilde og dato gemt', pr.salgstempo.kilde === 'beregnet' && pr.salgstempo.dato === '2026-11-02');
  check('maanedlig og seneste8 gemt', pr.salgstempo.maanedlig.length === 12 && pr.salgstempo.seneste8 === 13.4);
  check('andre produkter urørt', s.products.find(x => x.sku === 'KN-1003').rate === 12 && !s.products.find(x => x.sku === 'KN-1003').salgstempo);
  const txt = await p.$eval('#p-produkter', el => el.textContent);
  check('kilde vises', txt.includes('Beregnet (52 uger,') && txt.includes('Sikkerhed: middel') && txt.includes('muligt udsolgt'), txt.slice(0, 300));
  check('flag fra filen escapes', await p.$('#p-produkter img') === null);

  // Rate bruges i kalenderen og overlever genindlæsning
  await p.reload();
  await p.evaluate(() => { document.getElementById('sec-produkter').open = true; });
  check('import overlever genindlæsning', await inputRate('havtorn-saebe') === '12.4');

  // Anden redigering afrunder ikke; rettet rate bliver til Estimat
  await p.fill('#min-havtorn-saebe', '51'); await p.dispatchEvent('#min-havtorn-saebe', 'change');
  check('andet felt rører ikke raten', await rate('KN-1001') === 12.4);
  await p.fill('#rate-hyben-saebe', '17.5'); await p.dispatchEvent('#rate-hyben-saebe', 'change');
  const h = (await state()).products.find(x => x.sku === 'KN-1002');
  check('rettet rate gemmes med decimal og bliver Estimat', h.rate === 17.5 && !h.salgstempo);

  // Ugyldige filer ændrer intet og vælter ikke siden
  const before = JSON.stringify(await state());
  for (const [navn, data] of [['ikke JSON', '{ups'], ['liste', [1, 2]], ['tom', {}], ['ugyldig rate', { 'KN-1001': post('mange') }], ['negativ rate', { 'KN-1001': post(-1) }], ['ugyldig dato', { 'KN-1001': post(5, { beregnet: 'i går' }) }]]) {
    await pick(data);
    await p.waitForSelector('#importClose');
    check(`afvises: ${navn}`, JSON.stringify(await state()) === before);
    await p.click('#importClose');
  }
  // Samme fil kan vælges igen, og delvist ugyldig fil rapporterer det ugyldige
  await pick({ 'KN-1003': post(11), 'KN-1004': post('x') });
  await p.waitForSelector('#importYes');
  check('ugyldig post rapporteres', (await dlgText()).includes('Ugyldige i filen: KN-1004'));
  await p.click('#importNo');

  // Fuld præcision gemmes, men feltet viser to decimaler, og lavt_salg vises på dansk
  await pick({ 'KN-1006': post(0.5384615384615384, { flag: ['lavt_salg'] }) });
  await p.waitForSelector('#importYes');
  check('bekræftelsen afrunder', (await dlgText()).includes('5 → 0,54'), await dlgText());
  await p.click('#importYes');
  await p.click('#importClose');
  check('feltet viser to decimaler', await inputRate('lanolin-saebe') === '0.54', await inputRate('lanolin-saebe'));
  check('fuld præcision er gemt', await rate('KN-1006') === 0.5384615384615384);
  await p.fill('#min-lanolin-saebe', '21'); await p.dispatchEvent('#min-lanolin-saebe', 'change');
  check('anden redigering bevarer fuld præcision', await rate('KN-1006') === 0.5384615384615384);
  check('lavt salg vises', (await p.$eval('#p-produkter', el => el.textContent)).includes('lavt salg'));

  // Nulstil rydder importen
  await p.click('#btnReset'); await p.click('#btnResetYes');
  check('nulstil giver Estimat igen', !(await state()).products.some(x => x.salgstempo));

  // Data under den gamle nøgle overtages og slettes ikke
  await p.evaluate(([k, o]) => { const d = JSON.parse(localStorage.getItem(k)); d.products[0].min = 77; localStorage.setItem(o, JSON.stringify(d)); localStorage.removeItem(k); }, [KEY, OLD_KEY]);
  await p.reload();
  check('data fra gammel nøgle bevares', await p.$eval('#min-havtorn-saebe', el => el.value) === '77');
  check('gammel nøgle er urørt', await p.evaluate(o => localStorage.getItem(o) !== null, OLD_KEY));

  check('ingen JavaScript-fejl', errs.length === 0, errs.join('; '));
  await b.close();
  process.exit(failed ? 1 : 0);
})();
