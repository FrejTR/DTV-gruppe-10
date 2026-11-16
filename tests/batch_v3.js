// Tester batchnummer der kan stå tomt, ret batch og trinnene "Tag ud af forme" og "Skær kanter" i V3. Kørsel: node tests/batch_v3.js
// Ingen /api: kalenderen kører så uden Rackbeat (som ved åbning af filen).
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SIDE = '/v3/produktionskalender-v3.html';
const KEY = 'kystnaer-produktionskalender-v3';
let failed = false;
const check = (name, ok, info) => { console.log(ok ? 'OK   ' : 'FEJL ', name, ok ? '' : (info ?? '')); if (!ok) failed = true; };

const SRC = path.join(__dirname, '..', 'src');
const server = http.createServer((req, res) => {
  const fil = path.join(SRC, path.normalize(new URL(req.url, 'http://x').pathname));
  if (!fil.startsWith(SRC) || !fs.existsSync(fil)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(fil).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${server.address().port}${SIDE}`);
  // Uden server gemmes der først, når noget ændres: opret én planlagt batch for at få data i browseren
  await p.evaluate(() => document.querySelector('[data-plan]').click());
  await p.click('#bkindPlan', { force: true });
  await p.fill('#bWhoNew', 'Test');
  await p.click('#formBatch button[type=submit]');
  const visBatch = no => p.evaluate(n => document.querySelector(`[data-batch="${n}"]`).click(), no);
  const state = () => p.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY);
  const dag = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  // En lavet sæbebatch fra for 10 dage siden (begge trin er forfaldne) og en planlagt uden nummer
  await p.evaluate(([k, lavet, planlagt]) => {
    const S = JSON.parse(localStorage.getItem(k));
    const sæbe = S.products.find(x => x.type === 'Sæbebarer'), shampoo = S.products.find(x => x.type === 'Shampoobarer');
    S.people = ['Test']; S.nextNo = 3;
    S.batches = [
      { no: 1, label: '7', by: 'Test', pid: sæbe.id, qty: 20, made: lavet, cure: 22, status: 'aktiv' },
      { no: 2, label: '', by: 'Test', pid: shampoo.id, qty: 30, made: planlagt, cure: 7, status: 'planlagt' }];
    localStorage.setItem(k, JSON.stringify(S));
  }, [KEY, dag(-10), dag(5)]);
  await p.reload();

  // Trinnene
  for (const key of ['demold', 'trim']) {
    await p.click('[data-batch="1"]');
    await p.click(`dialog[open] [data-step$="|${key}"]`);
    check(`trinnet ${key} spørger ikke om sæbespåner`, !(await p.isVisible('#tResWrap')));
    await p.click('#formTrim button[type=submit]');
    check(`trinnet ${key} kan registreres`, !!(await state()).batches[0].steps?.[key]);
  }
  check('ingen fejl i siden ved trinnene', errs.length === 0, errs.join(' | '));

  // Planlagt batch uden nummer
  check('planlagt batch uden nummer vises som "uden nr."', (await p.textContent('#p-batches')).includes('uden nr.'));
  await p.click('[data-batch="2"]');
  check('detaljen viser "uden nr."', (await p.textContent('#detailBody')).includes('uden nr.'));
  await p.click('#dClose');

  // Ny planlagt batch med tomt nummer, og samme som lavet batch uden nummer
  await p.evaluate(() => document.querySelector('[data-plan]').click());
  await p.click('#bkindPlan', { force: true });
  check('planlægning starter med tomt nummer', (await p.inputValue('#bLines .l-no')) === '');
  await p.click('#bkindMade', { force: true });
  check('registrering som lavet foreslår et nummer', (await p.inputValue('#bLines .l-no')) !== '');
  await p.fill('#bLines .l-no', '');
  await p.click('#formBatch button[type=submit]');
  check('tomt nummer afvises, når batchen er lavet', (await p.textContent('#bErr')).includes('batchnummer'));
  await p.click('#bkindPlan', { force: true });
  await p.click('#formBatch button[type=submit]');
  const planlagt = (await state()).batches.filter(x => x.status === 'planlagt');
  check('planlagt batch kan gemmes uden nummer', planlagt.length === 2 && planlagt.every(x => x.label === ''), JSON.stringify(planlagt));

  // Ret batch
  await visBatch(1);
  await p.click('#dEdit');
  await p.fill('#eQty', '25'); await p.fill('#eNo', '7');
  const shampoo = (await state()).products.find(x => x.type === 'Shampoobarer').id;
  await p.selectOption('#eProd', shampoo);
  await p.fill('#eCure', '9');
  await p.click('#formEdit button[type=submit]');
  let b1 = (await state()).batches.find(x => x.no === 1);
  check('ret batch: produkt, antal og dage er ændret', b1.qty === 25 && b1.cure === 9 && b1.pid !== undefined, JSON.stringify(b1));
  check('ret batch: trin fra det gamle produkt er fjernet', !b1.steps || Object.keys(b1.steps).length === 0, JSON.stringify(b1.steps));
  await visBatch(1); await p.click('#dEdit');
  await p.fill('#eNo', '');
  await p.click('#formEdit button[type=submit]');
  check('ret batch: lavet batch kan ikke miste nummeret', !(await p.$eval('#eErr', e => e.hidden)));
  await p.fill('#eNo', '8');
  await p.click('#formEdit button[type=submit]');
  check('ret batch: nyt nummer gemmes', (await state()).batches.find(x => x.no === 1).label === '8');
  await visBatch(2); await p.click('#dEdit');
  await p.fill('#eNo', '8'); await p.click('#formEdit button[type=submit]');
  check('ret batch: nummer der er brugt afvises', (await p.textContent('#eErr')).includes('allerede brugt'));
  await p.fill('#eNo', '9'); await p.click('#formEdit button[type=submit]');
  check('ret batch: planlagt batch kan få nummer senere', (await state()).batches.find(x => x.no === 2).label === '9');

  // Rediger og Slet er to knapper over hinanden i batchlisten. Sletning spørger først.
  const antal = async () => (await state()).batches.length;
  const foer = await antal();
  const knapper = await p.evaluate(() => { const r = [...document.querySelectorAll('#p-batches [data-edit="2"], #p-batches [data-del="2"]')].map(e => e.textContent.trim()); return r; });
  check('listen har knapperne Rediger og Slet', knapper.join() === 'Rediger,Slet', knapper.join());
  await p.evaluate(() => document.querySelector('#p-batches [data-del="2"]').click());
  check('slet: spørger først, om man er sikker', (await p.textContent('#delText')).includes('Er du sikker') && await antal() === foer);
  await p.click('#delNo');
  check('slet: Fortryd sletter ikke', await antal() === foer && !(await p.isVisible('#dlgDelete')));
  await p.evaluate(() => document.querySelector('#p-batches [data-del="2"]').click());
  await p.click('#delYes');
  check('slet: Ja sletter batchen', await antal() === foer - 1 && !(await state()).batches.some(x => x.no === 2));

  // Batch lagt på lager i Rackbeat: kun nummeret kan rettes, og sletning advarer
  await p.evaluate(k => { const S = JSON.parse(localStorage.getItem(k)); const b = S.batches.find(x => x.no === 1); b.packed = true; b.rackbeat = { antal: 25, dato: '2026-11-16', id: 5 }; localStorage.setItem(k, JSON.stringify(S)); }, KEY);
  await p.reload();
  await p.evaluate(() => document.querySelector('#p-batches [data-edit="1"]').click());
  check('Rackbeat-batch: antal er låst', await p.isDisabled('#eQty'));
  await p.click('#dlgEdit [data-close]');
  await p.evaluate(() => document.querySelector('#p-batches [data-del="1"]').click());
  check('Rackbeat-batch: sletning advarer om Rackbeat', (await p.textContent('#delText')).includes('Rackbeat'));

  // Ugevisningen starter i ugen før den nuværende, og den nuværende er markeret
  await p.reload();
  const uger = await p.evaluate(() => [...document.querySelectorAll('#weekGrid .wk-h, .wk-h')].map(e => ({ nu: e.classList.contains('now'), tekst: e.textContent })));
  check('ugevisningen starter en uge før nu', uger.length >= 2 && !uger[0].nu && uger[1].nu, JSON.stringify(uger));
  check('den nuværende uge er mærket "Nu"', uger[1].tekst.includes('Nu') && !uger[0].tekst.includes('Nu'));

  check('ingen fejl i siden', errs.length === 0, errs.join(' | '));
  await b.close(); server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
