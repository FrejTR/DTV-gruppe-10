// Lokal mock af Rackbeat til udvikling og test uden rigtig nøgle.
// Leverer GET /orders/lines og GET /products i samme format som Rackbeat ud fra tests/fixtures/eksempel_ordrehistorik.csv,
// og GET/POST /inventory-adjustments. En regulering ændrer mockens lager, så den ses i næste GET /products.
// Kørsel: node tests/mock_rackbeat.js [port]   (standard 8790)
// MOCK_NOEGLE (standard "lokal-test") er den nøgle, mocken godtager. MOCK_LAGER_STATUS=403 efterligner en nøgle uden lageradgang.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8790);
const NOEGLE = process.env.MOCK_NOEGLE || 'lokal-test';
const LAGER_STATUS = Number(process.env.MOCK_LAGER_STATUS || 0);

const [hoved, ...raekker] = fs.readFileSync(path.join(__dirname, 'fixtures', 'eksempel_ordrehistorik.csv'), 'utf-8')
  .replace(/^﻿/, '').trim().split(/\r?\n/);
const navne = hoved.split(';');
// Datoerne flyttes, så den nyeste ordre ligger i går. Så ser data friske ud, uanset hvornår mocken startes.
const rows = raekker.map(l => Object.fromEntries(l.split(';').map((v, i) => [navne[i], v])));
const iso = d => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;
const sidste = rows.map(r => iso(r.Ordredato)).sort().pop();
const forskyd = Math.round((Date.now() - 86400000 - Date.parse(sidste)) / 86400000);
const flyt = d => new Date(Date.parse(d) + forskyd * 86400000).toISOString().slice(0, 10);
const linjer = rows.map((r, i) => ({
  id: i + 1, text: 'Vare', item: { number: r['Varenr.'] || null }, quantities: { ordered: Number(r.Antal), shipped: 0 },
  order: { number: Number(r['Ordrenr.']), order_date: `${flyt(iso(r.Ordredato))}T10:00:00+01:00`,
    status: { is_cancelled: false }, customer: { number: 1, name: 'Testkunde' } },
}));
const lager = [...new Set(rows.map(r => r['Varenr.']).filter(Boolean))].map((sku, i) => ({ number: sku, stock_quantity: 20 + i * 7 }));

const side = (felt, alle, q) => {
  const limit = Number(q.get('limit') || 20), page = Number(q.get('page') || 1);
  return { [felt]: alle.slice((page - 1) * limit, page * limit), total: alle.length, pages: Math.ceil(alle.length / limit), limit, page };
};

const reguleringer = [];   // Nyeste først, som hos Rackbeat

// Samme påkrævede felter som Rackbeats "Create Inventory Adjustment". Ukendt vare giver 422.
function opretRegulering(k) {
  const fejl = {};
  for (const f of ['regulated_at', 'reason', 'adjustment_type', 'item_id']) if (!k[f]) fejl[f] = [`The ${f} field is required.`];
  if (k.adjustment_type === 'quantity' && !k.location) fejl.location = ['The location field is required.'];
  if (k.quantity === undefined && k.value === undefined) fejl.quantity = ['The Quantity field is required when Value is not present.'];
  const vare = lager.find(v => v.number === k.item_id);
  if (k.item_id && !vare) fejl.item_id = ['The selected item id is invalid.'];
  if (Object.keys(fejl).length) return [422, { errors: fejl }];
  const antal = Number(k.quantity);
  vare.stock_quantity = k.regulate_diff ? antal : vare.stock_quantity + antal;
  const r = { id: 2000 + reguleringer.length, reason: k.reason, description: k.description || '', regulated_value: k.adjustment_type,
    regulate_difference: !!k.regulate_diff, is_booked: false, regulation_type: { number: k.regulation_type },
    lines: [{ child_id: k.item_id, quantity: antal, location_id: k.location }], regulated_at: k.regulated_at };
  reguleringer.unshift(r);
  return [201, { inventory_regulation: r }];
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const svar = (status, krop) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(krop)); };
  if (req.headers.authorization !== `Bearer ${NOEGLE}`) return svar(401, { errors: { message: 'Unauthenticated.' } });
  if (u.pathname === '/inventory-adjustments') {
    if (req.method === 'GET') return svar(206, side('inventory_regulations', reguleringer, u.searchParams));
    if (req.method !== 'POST') return svar(405, { errors: { message: 'Metode ikke tilladt' } });
    let tekst = '';
    for await (const del of req) tekst += del;
    let k; try { k = JSON.parse(tekst); } catch { return svar(400, { errors: { message: 'Ugyldig JSON' } }); }
    return svar(...opretRegulering(k));
  }
  if (req.method !== 'GET') return svar(405, { errors: { message: 'Kun GET' } });
  if (u.pathname === '/orders/lines') {
    const fra = (u.searchParams.get('order_date_from') || '0000').slice(0, 10), til = (u.searchParams.get('order_date_to') || '9999').slice(0, 10);
    return svar(206, side('order_lines', linjer.filter(l => l.order.order_date.slice(0, 10) >= fra && l.order.order_date.slice(0, 10) <= til), u.searchParams));
  }
  if (u.pathname === '/products') {
    if (LAGER_STATUS) return svar(LAGER_STATUS, { errors: { message: 'This action is unauthorized.' } });
    return svar(206, side('products', lager, u.searchParams));
  }
  svar(404, { errors: { message: 'Not found' } });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock af Rackbeat på http://127.0.0.1:${PORT} (${linjer.length} ordrelinjer)`));
