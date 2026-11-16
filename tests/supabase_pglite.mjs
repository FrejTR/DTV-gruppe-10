// Supabase-erstatning til test og lokal udvikling: rigtig Postgres (PGlite) med migrationerne i supabase/migrations,
// og /rest/v1/rpc/<funktion> som hos Supabase (PostgREST). Kun RPC'er, for serveren bruger ikke andet.
// Kørsel som server: node tests/supabase_pglite.mjs [port]   (standard 8792, nøgle: MOCK_SUPABASE_NOEGLE eller "lokal-db")
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONER = path.join(ROD, 'supabase', 'migrations');
const FUNKTIONER = new Set(['hent_data', 'gem_data', 'reserver_pakning', 'bekraeft_pakning', 'annuller_pakning']);

/** Ny, tom database med Supabases roller og alle migrationer. */
export async function lavDatabase() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  for (const fil of fs.readdirSync(MIGRATIONER).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONER, fil), 'utf-8'));
  }
  return db;
}

const svar = (status, krop) => new Response(JSON.stringify(krop), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch, der svarer som Supabase: rigtig nøgle i apikey, POST /rest/v1/rpc/<funktion> med {"p": ...}.
 *  En fejl fra en funktion (raise exception) giver 400 med code, message og details som hos PostgREST. */
export function supabaseFetch(db, noegle) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const hoveder = new Headers(init.headers);
    if (hoveder.get('apikey') !== noegle || hoveder.get('authorization') !== `Bearer ${noegle}`) {
      return svar(401, { message: 'Invalid API key' });
    }
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(u.pathname);
    if (!m || !FUNKTIONER.has(m[1])) return svar(404, { code: 'PGRST202', message: 'Could not find the function' });
    if ((init.method || 'GET') !== 'POST') return svar(405, { message: 'Method not allowed' });
    let krop = {};
    try { krop = init.body ? JSON.parse(init.body) : {}; } catch { return svar(400, { code: 'PGRST102', message: 'Invalid JSON' }); }
    try {
      const r = await db.query(`select public.${m[1]}($1::jsonb) as r`, [JSON.stringify(krop.p ?? {})]);
      return svar(200, r.rows[0].r);
    } catch (e) {
      return svar(400, { code: e.code || 'P0001', message: e.message, details: e.detail ?? null, hint: null });
    }
  };
}

// Som selvstændig server til tests/dev_server.mjs og browsertest
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8792);
  const noegle = process.env.MOCK_SUPABASE_NOEGLE || 'lokal-db';
  const hent = supabaseFetch(await lavDatabase(), noegle);
  http.createServer(async (req, res) => {
    const dele = [];
    for await (const del of req) dele.push(del);
    const hoveder = Object.entries(req.headers).filter(([, v]) => typeof v === 'string');
    const s = await hent(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: hoveder, body: dele.length ? Buffer.concat(dele).toString('utf-8') : undefined });
    res.writeHead(s.status, { 'Content-Type': 'application/json' });
    res.end(await s.text());
  }).listen(port, '127.0.0.1', () => console.log(`Supabase-erstatning (PGlite) på http://127.0.0.1:${port}`));
}
