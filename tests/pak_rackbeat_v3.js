// Tester produktionslageret og pakning hele vejen: V3 i browser → tests/dev_server.mjs (de rigtige handlers i api/)
// → tests/supabase_pglite.mjs (rigtig Postgres med migrationerne) og tests/mock_rackbeat.js.
// Kun mock, lokal database og falske nøgler, aldrig den rigtige Rackbeat eller Supabase. Kørsel: node tests/pak_rackbeat_v3.js
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const MOCK_PORT = 8791, DEV_PORT = 8789, DB_PORT = 8792;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`, BASE = `http://127.0.0.1:${DEV_PORT}`, DB = `http://127.0.0.1:${DB_PORT}`;
const SIDE = '/v3/produktionskalender-v3.html';
const NOEGLE = 'lokal-test', DB_NOEGLE = 'lokal-db-test';
const KEY = 'kystnaer-produktionskalender-v3';

let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };
const vent = ms => new Promise(r => setTimeout(r, ms));
async function ventPaa(fn, ms = 8000) {
  for (const slut = Date.now() + ms; Date.now() < slut; await vent(50)) { try { if (await fn()) return true; } catch { /* prøv igen */ } }
  return false;
}

// Mocken, databasen og den lokale server får kun falske nøgler. Tomme værdier forhindrer, at .env's rigtige nøgler læses.
const ENV = { ...process.env, RACKBEAT_API_KEY: NOEGLE, RACKBEAT_BASE_URL: MOCK, MOCK_NOEGLE: NOEGLE, MOCK_LAGER_STATUS: '',
  SUPABASE_URL: DB, SUPABASE_SECRET_KEY: DB_NOEGLE, MOCK_SUPABASE_NOEGLE: DB_NOEGLE };
delete ENV.VERCEL;
const start = (fil, port) => spawn(process.execPath, [path.join(__dirname, fil), String(port)], { env: ENV, stdio: 'ignore' });

const mock = async (sti, init) => (await fetch(MOCK + sti, { ...init, headers: { Authorization: `Bearer ${NOEGLE}`, ...(init && init.headers) } })).json();
const lagerI = async sku => (await mock('/products?limit=1000&page=1')).products.find(p => p.number === sku).stock_quantity;
// Rackbeats liste viser kun kladder, medmindre is_booked=true, så begge hentes
const reguleringer = async () => [...(await mock('/inventory-adjustments?is_booked=true&limit=100&page=1')).inventory_regulations,
  ...(await mock('/inventory-adjustments?is_booked=false&limit=100&page=1')).inventory_regulations];
const database = async () => (await fetch(DB + '/rest/v1/rpc/hent_data', { method: 'POST', body: '{}',
  headers: { apikey: DB_NOEGLE, Authorization: `Bearer ${DB_NOEGLE}`, 'Content-Type': 'application/json' } })).json();

const dag = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function aaben(b) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p.errs = [];
  p.on('pageerror', e => p.errs.push(e.message));
  await p.goto(BASE + SIDE);
  return p;
}
const pille = (p, id) => p.$eval(id, el => el.textContent);
const gemt = p => ventPaa(async () => (await pille(p, '#rbPill')).startsWith('Rackbeat: opdateret') && (await pille(p, '#dbPill')) === 'Fælles data: gemt');
const raekke = (p, navn) => p.evaluate(n => { const r = [...document.querySelectorAll('#plTbl tbody tr')].find(x => x.textContent.includes(n));
  return r ? [...r.querySelectorAll('td.n')].map(c => Number(c.textContent)) : null; }, navn);
const klik = (p, sel) => p.evaluate(s => document.querySelector(s).click(), sel);
const dlg = p => p.$eval('#detailBody', el => el.textContent.replace(/\s+/g, ' '));
async function skriv(p, sel, v) { await p.fill(sel, String(v)); await p.dispatchEvent(sel, 'input'); }

(async () => {
  const boerne = [start('mock_rackbeat.js', MOCK_PORT), start('supabase_pglite.mjs', DB_PORT), start('dev_server.mjs', DEV_PORT)];
  const b = await chromium.launch();
  try {
    check('servere startet', await ventPaa(async () => (await fetch(BASE + SIDE)).ok && Array.isArray((await database()).batches)
      && (await fetch(MOCK + '/products', { headers: { Authorization: `Bearer ${NOEGLE}` } })).ok, 30000));

    // Første kalender: databasen er tom, så dens data sendes op
    const a = await aaben(b);
    check('A: forbundet og gemt i fælles data', await gemt(a), `${await pille(a, '#rbPill')} / ${await pille(a, '#dbPill')}`);
    check('A: produkterne er sendt til databasen', (await database()).produkter.length === 17);

    // Batches registreres i A (som om de var lavet): #32 er klar i dag (55 - 2 kasseret), #33 hærder, #41 er klar
    await a.evaluate(([k, d3, d1]) => {
      const s = JSON.parse(localStorage.getItem(k));
      s.people = ['Test'];
      s.batches = [
        { no: 32, label: '32', by: 'Test', pid: 'tang-shampoo', qty: 55, rejected: 2, made: d3, cure: 3, status: 'aktiv' },
        { no: 33, label: '33', by: 'Test', pid: 'tang-shampoo', qty: 40, made: d1, cure: 3, status: 'aktiv' },
        { no: 41, label: '41', by: 'Test', pid: 'havtorn-balsam', qty: 50, made: d1, cure: 1, status: 'aktiv' },
      ];
      localStorage.setItem(k, JSON.stringify(s));
    }, [KEY, dag(-3), dag(-1)]);
    await a.reload();
    check('A: nye batches sendes til databasen', await ventPaa(async () => (await database()).batches.length === 3), JSON.stringify((await database()).batches));
    check('A: personen er delt', (await database()).personer.includes('Test'));
    check('produktionslager: Tang shampoo hærder 40, klar 53, i alt 93', await ventPaa(async () => JSON.stringify(await raekke(a, 'Tang shampoo')) === '[40,53,93]'),
      JSON.stringify(await raekke(a, 'Tang shampoo')));

    // Pak 22, heraf 2 kasseret: 20 lægges på Hovedlager i Rackbeat
    const foer = await lagerI('TAN001');
    await klik(a, '[data-pakprod="tang-shampoo"]');
    await a.waitForSelector('#pkAntal');
    check('pakkedialog: foreslår alt, der er klar', (await a.$eval('#pkAntal', el => el.value)) === '53');
    await skriv(a, '#pkAntal', 22); await skriv(a, '#pkKas', 2);
    check('pakkedialog: viser batch og godkendt antal', (await dlg(a)).includes('#32: 22 stk. (2 kasseret)') && (await dlg(a)).includes('Lægges på Hovedlager i Rackbeat: 20 stk.'), await dlg(a));
    check('pakkedialog: knappen siger, hvad der lægges på lager', (await a.$eval('#pkYes', el => el.textContent)) === 'Pak og læg 20 stk. på lager');
    await skriv(a, '#pkAntal', 54);
    check('pakkedialog: mere end der er klar kan ikke pakkes', await a.$eval('#pkYes', el => el.disabled) && (await dlg(a)).includes('kun 53 stk. klar'));
    await skriv(a, '#pkAntal', 22);
    await a.click('#pkNo');
    check('annullér: intet sendt', (await lagerI('TAN001')) === foer && (await reguleringer()).length === 0 && (await database()).pakninger.length === 0);

    await klik(a, '[data-pakprod="tang-shampoo"]');
    await a.waitForSelector('#pkAntal');
    await skriv(a, '#pkAntal', 22); await skriv(a, '#pkKas', 2);
    await a.click('#pkYes');
    check('dialogen lukker efter svar', await ventPaa(() => a.$eval('#dlgDetail', d => !d.open)), await dlg(a));
    check('lageret i Rackbeat er steget med 20', (await lagerI('TAN001')) === foer + 20, `${foer} → ${await lagerI('TAN001')}`);
    const [r] = await reguleringer();
    const [pk] = (await database()).pakninger;
    check('reguleringen er bogført, lægger til og ligger på Hovedlager i Produktion', r && r.is_booked === true && r.regulate_difference === false
      && r.lines[0].location_id === 1001 && r.lines[0].quantity === 20 && r.regulation_type.number === 1004 && r.reason === 'Pakket fra batch #32'
      && pk && r.description.includes(pk.ref), JSON.stringify(r));
    check('pakningen er gemt som bogført med linjen fra batch #32', pk && pk.status === 'bogfoert' && pk.antal === 22 && pk.kasseret === 2
      && JSON.stringify(pk.linjer.map(l => [l.batch, l.antal, l.kasseret])) === '[[32,22,2]]', JSON.stringify(pk));
    check('produktionslager: 31 klar efter pakningen', JSON.stringify(await raekke(a, 'Tang shampoo')) === '[40,31,71]', JSON.stringify(await raekke(a, 'Tang shampoo')));
    check('kalenderen viser det nye lager med det samme (under 5 sek.)', await ventPaa(() => a.evaluate(n =>
      document.getElementById('lager-tang-shampoo').textContent.trim() === String(n), foer + 20), 5000));
    check('batchlisten viser, hvad der er pakket', (await a.$eval('#batchTbl', el => el.textContent)).includes('22 pakket, 31 tilbage'));

    // Anden kalender (anden computer): ser samme batches og produktionslager fra databasen
    const bb = await aaben(b);
    check('B: forbundet og gemt', await gemt(bb), `${await pille(bb, '#rbPill')} / ${await pille(bb, '#dbPill')}`);
    check('B: ser produktionslageret fra A', JSON.stringify(await raekke(bb, 'Tang shampoo')) === '[40,31,71]', JSON.stringify(await raekke(bb, 'Tang shampoo')));
    check('B: ser batches fra A', (await bb.evaluate(k => JSON.parse(localStorage.getItem(k)).batches.map(x => x.no).sort().join(','), KEY)) === '32,33,41');

    // To kalendere kan ikke pakke de samme stk.: serveren afviser, når der ikke er nok klar
    const for_meget = await bb.evaluate(async () => { const r = await fetch('/api/pak', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'pak-test-for-meget', pid: 'tang-shampoo', sku: 'TAN001', antal: 32, kasseret: 0 }) }); return [r.status, await r.json()]; });
    check('for mange stk. afvises med antallet, der er klar', for_meget[0] === 409 && for_meget[1].klar === 31, JSON.stringify(for_meget));

    // En ændring i B (kasserede på #41) når frem til A
    await bb.evaluate(() => { const i = document.getElementById('brej-41'); i.value = '4'; i.dispatchEvent(new Event('change', { bubbles: true })); });
    check('B: ændringen er gemt i databasen', await ventPaa(async () => (await database()).batches.find(x => x.no === 41).rejected === 4));
    check('A: ser ændringen fra B inden for 25 sek.', await ventPaa(async () => JSON.stringify(await raekke(a, 'Havtorn balsam')) === '[0,46,46]', 25000),
      JSON.stringify(await raekke(a, 'Havtorn balsam')));

    // Rackbeat afviser (ukendt varenummer): fejl vises, og stk. bliver på produktionslageret
    await a.evaluate(k => { const s = JSON.parse(localStorage.getItem(k)); s.products.find(x => x.id === 'havtorn-balsam').sku = 'FINDES-IKKE'; localStorage.setItem(k, JSON.stringify(s)); }, KEY);
    await a.reload();
    await gemt(a);
    await klik(a, '[data-pakprod="havtorn-balsam"]');
    await a.waitForSelector('#pkYes');
    await a.click('#pkYes');
    check('ukendt varenummer vises', await ventPaa(() => a.$eval('#pkErr', el => !el.hidden && el.textContent.includes('findes ikke i Rackbeat'))), await a.$eval('#pkErr', el => el.textContent));
    check('afvist pakning er ikke gemt, og intet er sendt til Rackbeat', (await database()).pakninger.length === 1 && (await reguleringer()).length === 1);
    check('knappen hedder nu Prøv igen', (await a.$eval('#pkYes', el => el.textContent)) === 'Prøv igen');
    await a.click('#pkNo');
    check('stk. er stadig på produktionslageret', JSON.stringify(await raekke(a, 'Havtorn balsam')) === '[0,46,46]');

    // En batch er "Klar til pakning" (grøn), til alle stk. er pakket eller kasseret. Bjælken fortsætter til i dag.
    // #50 Hyben shampoo bar: 30 stk., klar for 3 dage siden
    await a.evaluate(([k, d10]) => { const s = JSON.parse(localStorage.getItem(k));
      s.batches.push({ no: 50, label: '50', by: 'Test', pid: 'hyben-shampoo', qty: 30, made: d10, cure: 7, status: 'aktiv' });
      localStorage.setItem(k, JSON.stringify(s)); }, [KEY, dag(-10)]);
    await a.reload();
    await gemt(a);
    const status50 = () => a.evaluate(() => [...document.querySelectorAll('#batchTbl tbody tr')].find(r => r.textContent.includes('#50')).querySelector('.chip').textContent);
    // Kolonnen for i dag i ugeoversigten: den nuværende uges første kolonne plus ugedagen (mandag = 0)
    const iDagKol = await a.evaluate(() => parseInt(document.querySelector('.wk-h.now').style.gridColumn, 10) + (new Date().getDay() + 6) % 7);
    const bjaelke = cls => a.evaluate(c => [...document.querySelectorAll(`.bar.${c}[data-batch="50"]`)].map(x => x.style.gridColumn.replace(/\s/g, '')), cls);
    const slutter = async (cls, kol) => (await bjaelke(cls)).some(g => Number(g.split('/')[1]) === kol + 1);
    check('#50: klar til pakning', (await status50()) === 'Klar til pakning', await status50());
    check('#50: grøn bjælke fortsætter til i dag', await slutter('s-green', iDagKol), JSON.stringify(await bjaelke('s-green')));

    const pak = async (antal, kas) => {
      await klik(a, '[data-pakprod="hyben-shampoo"]');
      await a.waitForSelector('#pkAntal');
      await skriv(a, '#pkAntal', antal); await skriv(a, '#pkKas', kas);
      await a.click('#pkYes');
      return ventPaa(() => a.$eval('#dlgDetail', d => !d.open));
    };
    check('#50: 10 stk. pakket', await pak(10, 0));
    check('#50: delvist pakket er stadig klar til pakning', (await status50()) === 'Klar til pakning' && await slutter('s-green', iDagKol), await status50());
    check('#50: resten pakket (15 godkendt, 5 kasseret)', await pak(20, 5));
    check('#50: pakket og lagt i Rackbeat', await ventPaa(async () => (await status50()) === 'Pakket og lagt i Rackbeat'), await status50());
    check('#50: mørkegrøn bjælke slutter i dag, ingen grøn', await slutter('s-packed', iDagKol) && (await bjaelke('s-green')).length === 0,
      JSON.stringify([await bjaelke('s-packed'), await bjaelke('s-green')]));
    check('#50: ikke længere på produktionslageret', (await raekke(a, 'Hyben shampoo')) === null);

    // En batch, der er pakket fra: kun nummeret kan rettes, men den kan slettes (fx testdata). Rackbeat røres ikke.
    await klik(a, '[data-edit="50"]');
    await a.waitForSelector('#dlgEdit[open]');
    check('#50: kun nummeret kan rettes', await a.$eval('#eQty', el => el.disabled) && await a.$eval('#eProd', el => el.disabled) && !(await a.$eval('#eNo', el => el.disabled)));
    await a.evaluate(() => document.getElementById('dlgEdit').close());
    const regFoer = (await reguleringer()).length, hybFoer = await lagerI('HYB001');
    await klik(a, '[data-del="50"]');
    await a.waitForSelector('#dlgDelete[open]');
    check('#50: sletning advarer om pakningerne og Rackbeat', !(await a.$eval('#delYes', el => el.hidden)) && (await a.$eval('#delText', el => el.textContent)).includes('bliver liggende'));
    await a.click('#delYes');
    check('#50: batchen og dens pakninger er slettet i databasen', await ventPaa(async () => { const d = await database();
      return !d.batches.some(x => x.no === 50) && !d.pakninger.some(k => k.linjer.some(l => l.batch === 50)); }));
    check('#50: Rackbeat er urørt', (await reguleringer()).length === regFoer && (await lagerI('HYB001')) === hybFoer);

    // Et produkt kan slettes helt, også fra de andre kalendere, men kun når intet hører til det
    const produkterI = pg => pg.evaluate(k => JSON.parse(localStorage.getItem(k)).products.map(x => x.id), KEY);
    await a.evaluate(() => { document.getElementById('sec-produkter').open = true; });
    await klik(a, '#btnNewProd');
    await a.fill('#npName', 'Testvare'); await a.fill('#npSku', 'TST001');
    await a.click('#formProd button[type=submit]');
    check('nyt produkt gemmes i databasen', await ventPaa(async () => (await database()).produkter.some(x => x.id === 'testvare')));
    check('B får det nye produkt', await ventPaa(async () => (await produkterI(bb)).includes('testvare'), 25000));
    await klik(a, '[data-ask-delprod="testvare"]');
    check('sletning skal bekræftes', !!(await a.$('[data-delprod="testvare"]')) && (await produkterI(a)).includes('testvare'));
    await klik(a, '[data-delprod="testvare"]');
    check('produktet er slettet i A og i databasen', !(await produkterI(a)).includes('testvare')
      && await ventPaa(async () => !(await database()).produkter.some(x => x.id === 'testvare')));
    check('produktet forsvinder også i B', await ventPaa(async () => !(await produkterI(bb)).includes('testvare'), 25000));
    await klik(a, '[data-ask-delprod="tang-shampoo"]');
    check('et produkt med batches kan ikke slettes', !(await a.$('[data-delprod="tang-shampoo"]')) && (await produkterI(a)).includes('tang-shampoo')
      && (await a.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' '))).includes('kan ikke slettes'));

    // Historik: fanen nederst viser alt fra begge kalendere, nyeste først, med tidspunkt og hvorfra
    const histLinjer = p => p.$$eval('#histTbl tbody tr[data-hist]', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    await a.evaluate(() => { const d = document.getElementById('sec-historik'); d.open = true; d.scrollIntoView(); });
    check('historik: hentes, når fanen åbnes', await ventPaa(async () => (await histLinjer(a)).length > 5));
    let hl = await histLinjer(a);
    check('historik: pakning med Rackbeat-regulering og beholdning', hl.some(x => /Pakket og lagt i Rackbeat · Hyben shampoo bar \(HYB001\)/.test(x) && /Lagt på Hovedlager i Rackbeat: \d+ stk\. \(regulering \d+, beholdning \d+ → \d+\)/.test(x)), hl.slice(0, 5).join(' | '));
    check('historik: produktet oprettet og slettet', hl.some(x => x.includes('Produkt slettet · Testvare')) && hl.some(x => x.includes('Produkt oprettet · Testvare')));
    check('historik: nyeste først', hl[0].includes('Produkt slettet'), hl[0]);
    check('historik: tidspunkt med dato og sekunder', /\d{1,2}\. \w+\.? \d{4}.*\d{2}[.:]\d{2}[.:]\d{2}/.test(hl[0]), hl[0]);
    check('historik: hvorfra, og denne browser er mærket', /Chromium på|Chrome på/.test(hl[0]) && hl[0].includes('(denne browser)'), hl[0]);
    check('historik: B ser de samme linjer, men ikke som sine egne', await ventPaa(async () => {
      await bb.evaluate(() => { document.getElementById('sec-historik').open = true; });
      const x = await histLinjer(bb); return x.length && x[0].includes('Produkt slettet') && !x[0].includes('(denne browser)');
    }, 15000));
    await a.selectOption('#histKat', 'pakning');
    check('historik: filter på pakning', await ventPaa(async () => { const x = await histLinjer(a); return x.length > 0 && x.every(y => /Pakket og lagt i Rackbeat|Pakning fejlede/.test(y)); }));
    await a.selectOption('#histKat', '');
    await a.fill('#histSoeg', 'testvare');
    check('historik: søgning', await ventPaa(async () => { const x = await histLinjer(a); return x.length === 2 && x.every(y => /Testvare/.test(y)); }), (await histLinjer(a)).join(' | '));
    await a.fill('#histSoeg', '');
    await ventPaa(async () => (await histLinjer(a)).length > 5);
    // En ny ændring kommer øverst af sig selv, mens fanen er åben
    const foerAntal = (await histLinjer(a)).length;
    await a.evaluate(() => { document.getElementById('sec-produkter').open = true; });
    await a.fill('#min-tang-shampoo', '31');
    await a.dispatchEvent('#min-tang-shampoo', 'change');
    await a.evaluate(() => document.activeElement && document.activeElement.blur());
    check('historik: ny ændring kommer øverst af sig selv', await ventPaa(async () => { const x = await histLinjer(a); return x.length > foerAntal && /Produkt ændret · Tang shampoo/.test(x[0]) && /Minimum: \d+ → 31/.test(x[0]); }, 25000), (await histLinjer(a))[0]);

    // Uden server (åbnet som fil) pakkes kun i kalenderen
    const f = await (await b.newContext()).newPage();
    f.errs = [];
    f.on('pageerror', e => f.errs.push(e.message));
    const fil = 'file://' + path.resolve(__dirname, '..', 'src', 'v3', 'produktionskalender-v3.html');
    await f.goto(fil);
    await f.evaluate(([k, d3, idag]) => localStorage.setItem(k, JSON.stringify({ people: ['Test'], res: [],
      products: [{ id: 'tang-shampoo', name: 'Tang shampoo bar', type: 'Shampoobarer', min: 30, rate: 0, count: 0, countDate: idag, batch: 55, sku: 'TAN001', cure: 3, steps: [] }],
      batches: [{ no: 32, label: '32', by: 'Test', pid: 'tang-shampoo', qty: 55, rejected: 2, made: d3, cure: 3, status: 'aktiv' }] })), [KEY, dag(-3), dag(0)]);
    await f.reload();
    check('uden server: fælles data vises som kun på denne computer', (await pille(f, '#dbPill')) === 'Fælles data: kun på denne computer');
    await klik(f, '[data-pakprod="tang-shampoo"]');
    await f.waitForSelector('#pkAntal');
    await skriv(f, '#pkAntal', 10);
    await f.click('#pkYes');
    const lokal = await f.evaluate(k => JSON.parse(localStorage.getItem(k)).pakninger, KEY);
    check('uden server: pakket lokalt uden Rackbeat', lokal.length === 1 && lokal[0].status === 'lokal' && lokal[0].antal === 10, JSON.stringify(lokal));
    await f.evaluate(() => { document.getElementById('sec-historik').open = true; });
    check('uden server: historikken forklarer, at den kræver databasen', await ventPaa(async () => (await f.textContent('#histStatus')).includes('kræver forbindelse til den fælles database')));
    check('uden server: produktionslageret er talt ned', JSON.stringify(await raekke(f, 'Tang shampoo')) === '[0,43,43]', JSON.stringify(await raekke(f, 'Tang shampoo')));

    const errs = [...a.errs, ...bb.errs, ...f.errs];
    check('ingen JavaScript-fejl', errs.length === 0, errs.join('; '));
  } finally {
    await b.close();
    boerne.forEach(c => c.kill());
  }
  process.exit(failed ? 1 : 0);
})();
