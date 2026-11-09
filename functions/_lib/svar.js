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
};

export function fejlSvar(kode) {
  const status = kode === 'ikke_sat_op' ? 503 : 502;
  return json({ data: null, hentet: null, forældet: true, kilde: 'rackbeat', fejl: TEKSTER[kode] || 'Rackbeat svarer ikke', kode }, status);
}

/** Logger aldrig nøgler, headers eller svar fra Rackbeat, kun hvad der skete. */
export function log(hvor, kode, status) {
  console.error(`[${hvor}] ${kode}${status ? ` (HTTP ${status})` : ''}`);
}

/** Dagens dato i Danmark (YYYY-MM-DD), uafhængigt af serverens tidszone. */
export const iDagIDanmark = (nu = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
