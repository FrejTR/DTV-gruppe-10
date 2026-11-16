// Test af, at lange historikker hentes side for side i rigtig rækkefølge, med få samtidige kald.
// Kørsel: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lavKlient, RackbeatFejl } from '../functions/_lib/rackbeat.js';

const linje = nr => ({ id: nr, item: { number: 'AKT001' }, quantities: { ordered: 1, shipped: 0 },
  order: { number: nr, order_date: '2026-10-05T09:30:00+01:00', status: { is_cancelled: false } } });

// Falsk Rackbeat med N sider à 2 linjer. Sidetallet står i hvert svar. Hver side tager lidt tid.
function falsk({ sider, fejlPaaSide = null, tom = null }) {
  const m = { iGang: 0, maks: 0, kald: [] };
  m.hent = async url => {
    const nr = Number(new URL(url).searchParams.get('page'));
    m.kald.push(nr);
    m.iGang++; m.maks = Math.max(m.maks, m.iGang);
    await new Promise(r => setTimeout(r, 5));
    m.iGang--;
    if (nr === fejlPaaSide) return { status: 500, json: async () => ({}) };
    const linjer = nr === tom ? [] : [linje(nr * 2 - 1), linje(nr * 2)];
    return { status: 206, json: async () => ({ order_lines: linjer, pages: sider, page: nr }) };
  };
  return m;
}
const klient = m => lavKlient({ noegle: 'x', fetch: m.hent, vent: async () => {}, pause: 0 });

test('sidehentning: alle sider kommer med, i rækkefølge', async () => {
  const m = falsk({ sider: 30 });
  const raa = await klient(m).ordrelinjer('2026-01-01', '2026-11-01', 100);
  assert.equal(raa.length, 60);
  assert.deepEqual(raa.map(r => r.ordre_id), Array.from({ length: 60 }, (_, i) => String(i + 1)));
  assert.deepEqual([...m.kald].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 1));
});

test('sidehentning: højst 4 kald ad gangen, og flere end ét', async () => {
  const m = falsk({ sider: 40 });
  await klient(m).ordrelinjer('2026-01-01', '2026-11-01', 100);
  assert.ok(m.maks > 1, 'hentes parallelt');
  assert.ok(m.maks <= 4, `højst 4 samtidige, var ${m.maks}`);
});

test('sidehentning: side 1 hentes først, og for mange sider afvises uden flere kald', async () => {
  const m = falsk({ sider: 500 });
  await assert.rejects(klient(m).ordrelinjer('2026-01-01', '2026-11-01', 200), e => e instanceof RackbeatFejl && e.kode === 'for_mange_sider');
  assert.deepEqual(m.kald, [1]);
});

test('sidehentning: en fejl på én side giver fejl, ikke en halv historik', async () => {
  const m = falsk({ sider: 20, fejlPaaSide: 7 });
  await assert.rejects(klient(m).ordrelinjer('2026-01-01', '2026-11-01', 100), e => e instanceof RackbeatFejl && e.kode === 'rackbeat_fejl');
  assert.ok(m.kald.length < 20, 'stopper med at hente flere sider efter fejlen');
});

test('sidehentning: en enkelt side og en tom historik virker', async () => {
  assert.equal((await klient(falsk({ sider: 1 })).ordrelinjer('2026-01-01', '2026-11-01', 100)).length, 2);
  assert.equal((await klient(falsk({ sider: 1, tom: 1 })).ordrelinjer('2026-01-01', '2026-11-01', 100)).length, 0);
});
