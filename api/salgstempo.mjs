// GET /api/salgstempo: salgstempo pr. varenummer, beregnet efter reglerne i README (functions/_lib/salgstempo.js).
// Kun GET. Adgangen styres af Vercel (Deployment Protection), før kaldet når hertil.
import { waitUntil } from '@vercel/functions';
import { salgstempo } from '../functions/_lib/endpoints.js';
import { lokaleDeps } from '../functions/_lib/lokal.js';

export const GET = request => salgstempo({ request, env: process.env, waitUntil }, lokaleDeps(request, process.env));
