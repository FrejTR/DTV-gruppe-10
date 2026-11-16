// GET /api/data: de fælles data (batches, reservationer, personer, produktindstillinger og produktionslager).
// POST /api/data: gemmer ændringer fra en kalender. Data ligger i Supabase (SUPABASE_URL, SUPABASE_SECRET_KEY),
// og kun serveren har nøglen. Adgangen styres af Vercel (Deployment Protection), før kaldet når hertil.
import { gemData, hentData } from '../functions/_lib/faelles.js';

export const GET = request => hentData({ request, env: process.env });
export const POST = request => gemData({ request, env: process.env });
