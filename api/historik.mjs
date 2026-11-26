// GET /api/historik: historikken over ændringer og handlinger i kalenderen, nyeste først (til fejlfinding).
// Query: foer (id, hent ældre end den), antal (1-500), kategori, soeg. Data ligger i Supabase. Se docs/rackbeat-opsaetning.md §9.
import { hentHistorik } from '../functions/_lib/faelles.js';

export const GET = request => hentHistorik({ request, env: process.env });
