// Viser, at serverens JavaScript-port giver samme salgstempo som scripts/beregn_salgstempo.py
// på data/eksempel_ordrehistorik.csv. Kørsel: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beregnAlle, normaliser, tilKlient } from '../functions/_lib/salgstempo.js';
import { ordrelinjeTilRaa } from '../functions/_lib/rackbeat.js';

const ROD = fileURLToPath(new URL('..', import.meta.url));
const CSV = ROD + 'data/eksempel_ordrehistorik.csv';
const PYTHON = process.env.PYTHON || 'python3';

function pythonResultat(dato, medKanal) {
  const kode = `
import json, sys
sys.path.insert(0, 'scripts')
from datetime import date
import beregn_salgstempo as bs, ordrekilder as ok
kol = {"dato": "Ordredato", "sku": "Varenr.", "antal": "Antal", "kanal": ${medKanal ? '"Kanal"' : 'None'}, "ordre_id": "Ordrenr."}
linjer = ok.fil_kilde(${JSON.stringify(CSV)}, kol).hent_ordrelinjer()
print(json.dumps(bs.beregn_alle(linjer, date.fromisoformat("${dato}"), 52)))
`;
  const p = spawnSync(PYTHON, ['-c', kode], { cwd: ROD, encoding: 'utf-8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

function csvRaekker() {
  const [hoved, ...linjer] = readFileSync(CSV, 'utf-8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const navne = hoved.split(';');
  return linjer.map(l => Object.fromEntries(l.split(';').map((v, i) => [navne[i], v])));
}
const isoFraDansk = d => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

function jsResultat(dato, medKanal) {
  const raa = csvRaekker().map(r => ({
    dato: isoFraDansk(r.Ordredato), sku: r['Varenr.'], antal: Number(r.Antal),
    kanal: medKanal ? r.Kanal : null, ordre_id: r['Ordrenr.'],
  }));
  return beregnAlle(normaliser(raa).linjer, dato, 52);
}

function sammenlign(py, js, sted) {
  if (py === null || typeof py !== 'number') return assert.deepEqual(js, py, sted);
  assert.equal(typeof js, 'number', sted);
  assert.ok(Math.abs(py - js) <= 1e-9 * Math.max(1, Math.abs(py)), `${sted}: Python ${py}, JS ${js}`);
}

function assertParitet(py, js) {
  assert.deepEqual(Object.keys(js).sort(), Object.keys(py).sort());
  for (const sku of Object.keys(py)) {
    for (const felt of Object.keys(py[sku])) {
      const a = py[sku][felt], b = js[sku][felt];
      if (Array.isArray(a)) { assert.equal(b.length, a.length); a.forEach((v, i) => sammenlign(v, b[i], `${sku}.${felt}[${i}]`)); }
      else sammenlign(a, b, `${sku}.${felt}`);
    }
  }
}

for (const dato of ['2026-11-02', '2026-06-17']) {
  for (const medKanal of [true, false]) {
    test(`samme resultat som Python (${dato}, ${medKanal ? 'med' : 'uden'} kanal)`, () => {
      assertParitet(pythonResultat(dato, medKanal), jsResultat(dato, medKanal));
    });
  }
}

test('eksempeldata rammer de indbyggede situationer', () => {
  const r = jsResultat('2026-11-02', true);
  assert.ok(r.HAT003.engangsordrer_stk >= 180);
  assert.ok(r.HYB001.flag.includes('muligt_udsolgt'));
  assert.ok(r.LAN002.flag.includes('lavt_salg'));
  assert.ok(r.NEU002.flag.includes('kort_historik'));
  assert.equal(r.NEU002.maanedlig[10], null);
});

test('samme resultat via Rackbeat-formatet (uden kanal, som i Rackbeat)', () => {
  // Hver CSV-linje omsættes til en ordrelinje, som Rackbeat leverer den, inkl. felter der skal kasseres
  const raa = csvRaekker().map(r => ordrelinjeTilRaa({
    item: { number: r['Varenr.'] }, quantities: { ordered: Number(r.Antal) },
    order: { number: Number(r['Ordrenr.']), order_date: isoFraDansk(r.Ordredato) + 'T10:00:00+01:00',
      status: { is_cancelled: false }, customer: { number: 1, name: 'Kunde A/S' } },
  })).filter(Boolean);
  const js = beregnAlle(normaliser(raa).linjer, '2026-11-02', 52);
  assertParitet(pythonResultat('2026-11-02', false), js);
  assert.ok(!JSON.stringify(raa).includes('Kunde'), 'kundenavnet må ikke komme med');
});

test('klientformatet svarer til JSON-filen fra scriptet', () => {
  const ud = tilKlient(jsResultat('2026-11-02', true), '2026-11-02');
  const post = ud.HAT003;
  assert.deepEqual(Object.keys(post).sort(), ['beregnet', 'engangsordrer_antal', 'engangsordrer_stk', 'flag',
    'maanedlig', 'rate', 'seneste8', 'sikkerhed', 'vindue_uger']);
  assert.equal(post.beregnet, '2026-11-02');
  assert.equal(post.maanedlig.length, 12);
});
