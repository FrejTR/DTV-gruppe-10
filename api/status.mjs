// GET /api/status: lager pr. varenummer (stock_quantity) fra Rackbeat.
// Kun GET. Andre metoder er ikke eksporteret, så Vercel svarer 405.
// Adgangen styres af Vercel (Deployment Protection), før kaldet når hertil. Se docs/rackbeat-opsaetning.md.
import { waitUntil } from '@vercel/functions';
import { status } from '../functions/_lib/endpoints.js';
import { lokaleDeps } from '../functions/_lib/lokal.js';

export const GET = request => status({ request, env: process.env, waitUntil }, lokaleDeps(request, process.env));
