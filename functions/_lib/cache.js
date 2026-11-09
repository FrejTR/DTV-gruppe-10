// Gemmer det seneste gode svar i isolatets hukommelse og i Cloudflares Cache API (pr. datacenter).
// Friskheden afgøres af tidspunktet i posten, ikke af cachens levetid, så en gammel post
// stadig kan sendes som forældet, når Rackbeat ikke svarer.

const GEM_I_SEKUNDER = 7 * 24 * 3600;
const hukommelse = new Map();
const igang = new Map();

const cacheApi = () => (typeof caches !== 'undefined' && caches.default) || null;
const noegleUrl = (origin, navn) => `${origin}/api/__cache/${navn}`;

export async function laes(origin, navn) {
  const lokal = hukommelse.get(navn) || null;
  const c = cacheApi();
  if (!c) return lokal;
  try {
    const svar = await c.match(noegleUrl(origin, navn));
    const delt = svar ? await svar.json() : null;
    // Et andet isolat i samme datacenter kan have hentet nyere data
    if (delt && (!lokal || delt.hentet > lokal.hentet)) { hukommelse.set(navn, delt); return delt; }
  } catch { /* Cachen er kun en hjælp */ }
  return lokal;
}

export async function gem(origin, navn, post) {
  hukommelse.set(navn, post);
  const c = cacheApi();
  if (!c) return;
  try {
    await c.put(noegleUrl(origin, navn), new Response(JSON.stringify(post), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${GEM_I_SEKUNDER}` },
    }));
  } catch { /* Cachen er kun en hjælp */ }
}

/** Kører kun én opdatering ad gangen pr. navn i dette isolat. */
export function enAdGangen(navn, opgave) {
  if (!igang.has(navn)) igang.set(navn, opgave().finally(() => igang.delete(navn)));
  return igang.get(navn);
}

/** Kun til test. */
export function _nulstil() { hukommelse.clear(); igang.clear(); }
