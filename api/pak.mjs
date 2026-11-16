// POST /api/pak: tager et antal stk. ud af produktionslageret (ældste batch, der er klar, først) og lægger de
// godkendte på Hovedlager i Rackbeat. Bruger RACKBEAT_API_KEY og Supabase. Se docs/rackbeat-opsaetning.md.
import { pak } from '../functions/_lib/faelles.js';
import { lokaleDeps } from '../functions/_lib/lokal.js';

export const POST = request => pak({ request, env: process.env }, { rackbeat: lokaleDeps(request, process.env) });
