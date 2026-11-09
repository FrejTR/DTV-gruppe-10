// Tjekker Cloudflare Access-tokenet (header Cf-Access-Jwt-Assertion): RS256-signatur mod
// Cloudflares offentlige nøgler, udsteder (team-domænet), audience (AUD-tag) og udløb.
// Kilde: developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

const NOEGLER_GYLDIGE_MS = 3600 * 1000;
const SPOERG_IGEN_MS = 60 * 1000;   // Ukendt kid (nøglerotation) giver højst ét nyt opslag i minuttet
const SKAEVHED_S = 60;
let noeglecache = { team: null, hentet: 0, tvunget: 0, noegler: [] };

const b64url = s => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const json = s => JSON.parse(new TextDecoder().decode(b64url(s)));

/** Lokal udvikling uden Access kræver både variablen og en lokal adresse. Aldrig standard. */
export function erLokalUdvikling(request, env) {
  if (env.LOKAL_UDVIKLING_UDEN_ACCESS !== 'ja') return false;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

async function hentNoegler(team, hent, tving) {
  const nu = Date.now();
  const sammeTeam = noeglecache.team === team;
  const frisk = sammeTeam && (tving ? nu - noeglecache.tvunget < SPOERG_IGEN_MS : nu - noeglecache.hentet < NOEGLER_GYLDIGE_MS);
  if (frisk) return noeglecache.noegler;
  const svar = await hent(`${team}/cdn-cgi/access/certs`, { method: 'GET' });
  if (!svar.ok) throw new Error('certs');
  const data = await svar.json();
  noeglecache = { team, hentet: nu, tvunget: tving ? nu : (sammeTeam ? noeglecache.tvunget : 0), noegler: Array.isArray(data.keys) ? data.keys : [] };
  return noeglecache.noegler;
}

/** Returnerer true, hvis tokenet er gyldigt. Kaster ved manglende opsætning eller nøgleopslag. */
export async function verificerToken(token, { team, aud, hent = globalThis.fetch, nu = Date.now() }) {
  if (!team || !aud) throw new Error('opsaetning');
  if (typeof token !== 'string') return false;
  const dele = token.split('.');
  if (dele.length !== 3) return false;
  let hoved, krop;
  try { hoved = json(dele[0]); krop = json(dele[1]); } catch { return false; }
  if (hoved.alg !== 'RS256' || typeof hoved.kid !== 'string') return false;

  let jwk = (await hentNoegler(team, hent, false)).find(k => k.kid === hoved.kid);
  if (!jwk) jwk = (await hentNoegler(team, hent, true)).find(k => k.kid === hoved.kid);
  if (!jwk || jwk.kty !== 'RSA') return false;

  let gyldig;
  try {
    const noegle = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    gyldig = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', noegle, b64url(dele[2]),
      new TextEncoder().encode(`${dele[0]}.${dele[1]}`));
  } catch { return false; }
  if (!gyldig) return false;

  const sek = Math.floor(nu / 1000);
  const auds = Array.isArray(krop.aud) ? krop.aud : [krop.aud];
  return krop.iss === team && auds.includes(aud)
    && typeof krop.exp === 'number' && krop.exp > sek - SKAEVHED_S
    && (krop.nbf === undefined || krop.nbf <= sek + SKAEVHED_S);
}

/** Kun til test. */
export function _nulstil() { noeglecache = { team: null, hentet: 0, tvunget: 0, noegler: [] }; }
