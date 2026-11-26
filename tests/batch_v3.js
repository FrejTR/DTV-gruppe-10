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

  // Skær kanter kan først vælges, når batchen er taget ud af formene
  check('skær kanter tilbydes ikke, før den er taget ud af formene', (await p.$$('[data-step$="|trim"]')).length === 0 && (await p.$$('[data-step$="|demold"]')).length > 0);
  await p.click('[data-batch="1"]');
  check('detaljen forklarer, at kanter først skæres efter udtagning', (await p.textContent('#detailBody')).includes('Først når batchen er taget ud af formene'));
  await p.click('#dClose');

  // Trinnene
  for (const key of ['demold', 'trim']) {
    await p.click('[data-batch="1"]');
    await p.click(`dialog[open] [data-step$="|${key}"]`);
    check(`trinnet ${key} spørger ikke om sæbespåner`, !(await p.isVisible('#tResWrap')));
    await p.click('#formTrim button[type=submit]');
    check(`trinnet ${key} kan registreres`, !!(await state()).batches[0].steps?.[key]);
  }
  await p.click('[data-batch="1"]'); await p.click('dialog[open] [data-unstep$="|demold"]');
  check('fortryd udtagning fjerner også kantskæringen', !(await state()).batches[0].steps?.trim && !(await state()).batches[0].steps?.demold, JSON.stringify((await state()).batches[0]));
  for (const key of ['demold', 'trim']) {
    await p.click('[data-batch="1"]'); await p.click(`dialog[open] [data-step$="|${key}"]`); await p.click('#formTrim button[type=submit]');
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
  check('ret batch: samme nummer som en anden batch er tilladt', (await state()).batches.filter(x => x.label === '8').length === 2);
  await visBatch(2); await p.click('#dEdit');
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

  // Kassation kræver en årsag
  await p.evaluate(k => { const S = JSON.parse(localStorage.getItem(k)); const b = S.batches.find(x => x.no === 1); b.packed = false; delete b.rackbeat; localStorage.setItem(k, JSON.stringify(S)); }, KEY);
  await p.reload();
  await p.evaluate(() => document.querySelector('[data-ask-discard="1"]').click());
  const batch1 = async () => (await state()).batches.find(x => x.no === 1);
  await p.click('#formDiscard button[type=submit]');
  check('kassér: uden årsag afvises', (await batch1()).status === 'aktiv' && !(await p.$eval('#discErr', e => e.hidden)));
  const valg = await p.$$eval('#discCat option', o => o.map(x => x.textContent.trim()).filter(x => x && !x.startsWith('Vælg')));
  check('kassér: de fem årsager findes', valg.join('|') === 'Vejer for lidt|Kosmetisk fejl|Fejl i opskrift|Fejl i håndtering|Andet', valg.join('|'));
  await p.selectOption('#discCat', 'Andet');
  check('kassér: Andet viser tekstfeltet', await p.isVisible('#discOther'));
  await p.click('#formDiscard button[type=submit]');
  check('kassér: Andet uden tekst afvises', (await batch1()).status === 'aktiv');
  await p.fill('#discOther', 'Formen revnede');
  await p.click('#formDiscard button[type=submit]');
  const k = await batch1();
  check('kassér: Andet med tekst gemmer årsagen', k.status === 'kasseret' && k.discardReason.kategori === 'Andet' && k.discardReason.tekst === 'Formen revnede', JSON.stringify(k));
  await p.evaluate(() => document.querySelector('[data-batch="1"]').click());
  check('kassér: årsagen vises i detaljerne', (await p.textContent('#detailBody')).includes('Formen revnede'));
  await p.click('#dRestore');
  check('gendan: årsagen fjernes', !(await batch1()).discardReason && (await batch1()).status === 'aktiv');
  await p.evaluate(() => document.querySelector('[data-batch="1"]').click());
  await p.click('#dDiscard');
  await p.selectOption('#discCat', 'Vejer for lidt');
  await p.click('#formDiscard button[type=submit]');
  check('kassér: fast kategori gemmes uden tekst', (await batch1()).discardReason?.kategori === 'Vejer for lidt');

  // Produktrækkefølge og rækkefarver i ugekalenderen
  await p.reload();
  const navne = () => p.$$eval('.wk-prod .wk-name strong', e => e.map(x => x.textContent));
  const foerNavne = await navne();
  await p.evaluate(() => document.querySelector('[data-move$="|1"]:not([disabled])').click());
  const efterNavne = await navne();
  check('flyt produkt ned bytter de to første', efterNavne[0] === foerNavne[1] && efterNavne[1] === foerNavne[0], efterNavne.slice(0, 2).join());
  await p.reload();
  check('rækkefølgen huskes efter genindlæsning', (await navne())[0] === foerNavne[1]);
  check('første række er hvid, anden har farve', await p.$$eval('.wk-prod', r => !r[0].classList.contains('alt') && r[1].classList.contains('alt')));
  const skift = await p.$$eval('.wk-prod', (r, ) => r.map(x => x.classList.contains('typeskift')));
  const typer = await p.evaluate(k => { const S = JSON.parse(localStorage.getItem(k)); return S.products.filter(x => !x.archived).map(x => x.type); }, KEY);
  check('dobbelt linje præcis hvor kategorien skifter', skift.every((v, i) => v === (i < typer.length - 1 && typer[i] !== typer[i + 1])), JSON.stringify({ skift, typer }));

  // Ugevisningen starter i ugen før den nuværende, og den nuværende er markeret
  await p.reload();
  const uger = await p.evaluate(() => [...document.querySelectorAll('#weekGrid .wk-h, .wk-h')].map(e => ({ nu: e.classList.contains('now'), tekst: e.textContent })));
  check('ugevisningen starter en uge før nu', uger.length >= 2 && !uger[0].nu && uger[1].nu, JSON.stringify(uger));
  check('den nuværende uge er mærket "Nu"', uger[1].tekst.includes('Nu') && !uger[0].tekst.includes('Nu'));

  // Afsluttede batches: pakket og lagt i Rackbeat i mindst 7 dage skjules på Batches-listen, men slettes ikke
  await p.evaluate(([k, d40, d8, d6, d10]) => {
    const S = JSON.parse(localStorage.getItem(k));
    const sæbe = S.products.find(x => x.type === 'Sæbebarer');
    const ny = (no, label, extra) => ({ no, label, by: 'Test', pid: sæbe.id, qty: 20, made: d40, cure: 22, status: 'aktiv', ...extra });
    S.batches.push(ny(10, 'AF8', {}), ny(11, 'AF6', {}), ny(12, 'AFG', { packed: true, rackbeat: true, packedOn: d10 }), ny(13, 'AFL', { packed: true, packedOn: d10 }));
    const pak = (ref, no, dato) => ({ ref, pid: sæbe.id, antal: 20, kasseret: 0, dato, status: 'bogfoert', linjer: [{ batch: no, antal: 20, kasseret: 0 }] });
    S.pakninger = [pak('pak-a', 10, d8), pak('pak-b', 11, d6)];
    localStorage.setItem(k, JSON.stringify(S));
  }, [KEY, dag(-40), dag(-8), dag(-6), dag(-10)]);
  await p.reload();
  await p.evaluate(() => { document.getElementById('sec-batches').open = true; });
  const batchTekst = () => p.textContent('#batchTbl');
  let bt = await batchTekst();
  check('afsluttet for 8 dage siden skjules på Batches', !bt.includes('AF8'), bt.slice(0, 200));
  check('afsluttet for 6 dage siden vises stadig', bt.includes('AF6'));
  check('hele batchen lagt i Rackbeat for 10 dage siden skjules', !bt.includes('AFG'));
  check('pakket uden Rackbeat skjules ikke', bt.includes('AFL'));
  const st2 = await state();
  check('skjulte batches er stadig i data', [10, 12].every(n => st2.batches.some(x => x.no === n)) && st2.pakninger.length === 2);
  check('knappen viser antal skjulte', (await p.textContent('#batchAfsl')).trim() === 'Vis afsluttede (2)' && await p.isVisible('#batchAfsl'));
  await p.click('#batchAfsl');
  bt = await batchTekst();
  check('Vis afsluttede viser dem igen', bt.includes('AF8') && bt.includes('AFG') && (await p.textContent('#batchAfsl')).trim() === 'Skjul afsluttede (2)');
  await p.click('#batchAfsl');
  check('Skjul afsluttede skjuler dem igen', !(await batchTekst()).includes('AF8'));

  // Sæber: skær kanter og sæbespåner vælges til eller fra samlet pr. produkt under Produkter og minimum
  await p.evaluate(([k, d10]) => {
    const S = JSON.parse(localStorage.getItem(k));
    const sæbe = S.products.find(x => x.type === 'Sæbebarer');
    S.batches.push({ no: 20, label: 'KT1', by: 'Test', pid: sæbe.id, qty: 30, rejected: 4, rejectedOn: d10, made: d10, cure: 22, status: 'aktiv', steps: { demold: { on: d10, by: 'Test' } } });
    localStorage.setItem(k, JSON.stringify(S));
    localStorage.setItem('kystnaer-hvem', 'Test');
  }, [KEY, dag(-10)]);
  await p.reload();
  await p.evaluate(() => { document.getElementById('sec-produkter').open = true; document.getElementById('sec-batches').open = true; });
  const sæbeId = (await state()).products.find(x => x.type === 'Sæbebarer').id;
  const shampooId = (await state()).products.find(x => x.type === 'Shampoobarer').id;
  const findes = sel => p.evaluate(s => !!document.querySelector(s), sel);
  check('sæbe: valget findes og er slået til fra start', await p.isChecked('#pk-' + sæbeId));
  check('shampoo: intet valg om kanter', !(await findes('#pk-' + shampooId)));
  check('slået til: skær kanter og sæbespåner er opgaver', await findes('[data-step="20|trim"]') && await findes('[data-step="20|flakes"]'));
  await p.uncheck('#pk-' + sæbeId);
  check('fravalg gemmes på produktet', (await state()).products.find(x => x.id === sæbeId).kanter === false);
  check('fravalgt: ingen opgave med at skære kanter', !(await findes('[data-step="20|trim"]')));
  check('fravalgt: ingen opgave med sæbespåner', !(await findes('[data-step="20|flakes"]')));
  check('fravalgt: trinet står ikke under Trin undervejs', !(await findes(`#ps-trim-${sæbeId}`)) && await findes(`#ps-demold-${sæbeId}`));
  await visBatch(20);
  const dt = await p.textContent('#detailBody');
  check('fravalgt: detaljen nævner hverken kanter eller sæbespåner', !dt.includes('Sæbespåner') && !dt.includes('Skær kanter'), dt);
  await p.click('#dClose');
  await p.check('#pk-' + sæbeId);
  check('tilvalgt igen: opgaverne er tilbage', (await state()).products.find(x => x.id === sæbeId).kanter === true && await findes('[data-step="20|trim"]') && await findes('[data-step="20|flakes"]'));
  check('tilvalgt igen: dagen for kantskæring er bevaret', await p.inputValue(`#ps-trim-${sæbeId}`) === '8');

  // Nyt produkt: valget vises kun for sæber
  await p.click('#btnNewProd');
  await p.selectOption('#npType', 'Sæbebarer');
  check('nyt produkt: valget vises for sæber og er slået til', await p.isVisible('#npKanter') && await p.isChecked('#npKanter'));
  await p.uncheck('#npKanter');
  check('nyt produkt: uden kanter nævner forhåndsvisningen ikke kantskæring', !(await p.textContent('#npSteps')).includes('skær kanter'), await p.textContent('#npSteps'));
  await p.selectOption('#npType', 'Shampoobarer');
  check('nyt produkt: valget skjules for andre typer', !(await p.isVisible('#npKanter')));
  await p.selectOption('#npType', 'Sæbebarer');
  await p.fill('#npName', 'Test sæbe uden kanter');
  await p.click('#formProd button[type=submit]');
  const nyP = (await state()).products.find(x => x.name === 'Test sæbe uden kanter');
  check('nyt produkt: oprettes uden kanter', nyP && nyP.kanter === false && !(await findes(`#ps-trim-${nyP.id}`)), JSON.stringify(nyP));

  // Produkter og minimum: alle kolonner kan ses uden at scrolle sidelæns ved 1280 px (overskrifter ombrydes)
  const bredde = await p.evaluate(() => { document.getElementById('sec-produkter').open = true; const t = document.getElementById('prodTbl'); return { tabel: t.scrollWidth, plads: t.parentElement.clientWidth }; });
  check('produkttabellen passer i bredden ved 1280 px', bredde.tabel <= bredde.plads, JSON.stringify(bredde));

  check('ingen fejl i siden', errs.length === 0, errs.join(' | '));
  await b.close(); server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
