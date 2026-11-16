// Fælles svarformat: { data, hentet, forældet, kilde }. Fejl er korte og generiske.

const HOVEDER = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export const json = (krop, status = 200) => new Response(JSON.stringify(krop), { status, headers: HOVEDER });

export const dataSvar = (post, foraeldet) =>
  json({ data: post.data, hentet: new Date(post.hentet).toISOString(), forældet: foraeldet, kilde: 'rackbeat' });

const TEKSTER = {
  ikke_sat_op: 'Rackbeat er ikke sat op',
  noegle_afvist: 'Rackbeat afviste nøglen',
  mangler_adgang: 'Mangler adgang i Rackbeat',
  for_mange_kald: 'Rackbeat har for travlt',
  for_mange_sider: 'For mange data at hente',
  afvist_af_rackbeat: 'Rackbeat afviste reguleringen',
  ingen_forbindelse: 'Ingen forbindelse til Rackbeat',
  db_ikke_sat_op: 'Den fælles database er ikke sat op',
  db_noegle_afvist: 'Databasen afviste nøglen',
  db_ingen_forbindelse: 'Ingen forbindelse til databasen',
  db_fejl: 'Databasen svarer ikke',
};

export function fejlSvar(kode, kilde = 'rackbeat') {
  const status = kode === 'ikke_sat_op' || kode === 'db_ikke_sat_op' ? 503 : 502;
  const standard = kilde === 'rackbeat' ? 'Rackbeat svarer ikke' : 'Databasen svarer ikke';
  return json({ data: null, hentet: null, forældet: true, kilde, fejl: TEKSTER[kode] || standard, kode }, status);
}

/** Kun kald fra kalenderen selv. Vercel Authentication sender login-cookien med, så et kald fra
 *  en anden side skal afvises (CSRF). Origin skal matche, og kroppen skal være JSON. */
export function fraKalenderen(request) {
  const origin = request.headers.get('origin');
  const type = request.headers.get('content-type') || '';
  return origin === new URL(request.url).origin && type.split(';')[0].trim() === 'application/json';
}

/** Logger aldrig nøgler, headers eller svar fra Rackbeat, kun hvad der skete. */
export function log(hvor, kode, status) {
  console.error(`[${hvor}] ${kode}${status ? ` (HTTP ${status})` : ''}`);
}

/** Dagens dato i Danmark (YYYY-MM-DD), uafhængigt af serverens tidszone. */
export const iDagIDanmark = (nu = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
