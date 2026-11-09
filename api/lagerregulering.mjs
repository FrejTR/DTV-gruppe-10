// POST /api/lagerregulering: lægger en godkendt batch på Hovedlager i Rackbeat (lagerregulering, "læg til").
// Kun POST. Bruger RACKBEAT_API_KEY. Adgangen styres af Vercel (Deployment Protection), før kaldet når hertil,
// og funktionen afviser kald fra andre sider (Origin). Se docs/rackbeat-opsaetning.md.
import { lagerregulering } from '../functions/_lib/endpoints.js';
import { lokaleDeps } from '../functions/_lib/lokal.js';

export const POST = request => lagerregulering({ request, env: process.env }, lokaleDeps(request, process.env));
