// Adgang til Rackbeat. Læsning (lavKlient) er kun GET. Skrivning (lavSkriveKlient) er kun lagerreguleringer,
// der lægger et antal til beholdningen. Kun faste endpoints, og kun de felter, kalenderen bruger.
// Kilde: developer.rackbeat.com (Authentication, Pagination, Errors & Rate Limits, "List Lines for all Orders",
// "List Products" og "Create Inventory Adjustment"), slået op november 2026.

const BASIS_URL = 'https://app.rackbeat.com/api';
const PR_SIDE = 100;           // Dokumentationen nævner ingen øvre grænse; sidetallet læses fra svaret
const PAUSE_MELLEM_SIDER = 150; // ms mellem starten af to kald. Holder os under 480 kald i minuttet pr. konto
const SAMTIDIGE_KALD = 4;       // Så mange sider hentes samtidig, når en historik har mange sider

export class RackbeatFejl extends Error {
  /** kode er kort og generisk, så den kan vises i appen uden at afsløre noget. */
  constructor(kode, status = null) {
    super(kode);
    this.kode = kode;
    this.status = status;
  }
}

const KODER = { 401: 'noegle_afvist', 403: 'mangler_adgang', 404: 'ikke_fundet', 422: 'afvist_af_rackbeat', 429: 'for_mange_kald' };

// Lagerregulering ved godkendt batch. Afklaret med Kystnær og ud fra deres egne reguleringer i Rackbeat:
export const HOVEDLAGER = 1001;           // Lokation "Hovedlager" (Rackbeats standardlokation)
export const KATEGORI_PRODUKTION = 1004;  // Reguleringskategori "Produktion"

export function lavKlient({ noegle, fetch: hent = globalThis.fetch, vent = ms => new Promise(r => setTimeout(r, ms)), basisUrl = BASIS_URL, pause = PAUSE_MELLEM_SIDER }) {
  if (!noegle) throw new RackbeatFejl('ikke_sat_op');

  async function side(sti, params) {
    const url = `${basisUrl}${sti}?${new URLSearchParams(params)}`;
    let svar;
    try {
      svar = await hent(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${noegle}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      });
    } catch {
      throw new RackbeatFejl('ingen_forbindelse');
    }
    if (svar.status !== 200 && svar.status !== 206) {
      throw new RackbeatFejl(KODER[svar.status] || 'rackbeat_fejl', svar.status);
    }
    try {
      return await svar.json();
    } catch {
      throw new RackbeatFejl('uventet_svar', svar.status);
    }
  }

  /** Henter alle sider. Stopper med fejl i stedet for at returnere en halv historik.
   *  Side 1 først (den fortæller, hvor mange sider der er). Resten hentes med få kald ad gangen, så en lang
   *  historik når at blive hentet, før Vercel afbryder. Kaldene startes med `pause` imellem, så vi holder os
   *  under grænsen på 480 kald i minuttet pr. konto, selvom flere er i gang samtidig. */
  async function alleSider(sti, felt, params, maxSider) {
    const hentSide = async nr => {
      const data = await side(sti, { ...params, limit: PR_SIDE, page: nr });
      if (!data || typeof data !== 'object' || (data[felt] !== undefined && !Array.isArray(data[felt]))) {
        throw new RackbeatFejl('uventet_svar');
      }
      return data;
    };
    const foerste = await hentSide(1);
    const sider = Number.isInteger(foerste.pages) ? foerste.pages : 0;
    if (sider > maxSider) throw new RackbeatFejl('for_mange_sider');
    if (sider > 1) console.log(`[rackbeat] ${sti}: ${sider} sider`);   // Kun antal, så en timeout kan forklares
    const svar = [foerste];
    let fejl = null;
    const igang = new Set();
    for (let nr = 2; nr <= sider && !fejl; nr++) {
      if (igang.size >= SAMTIDIGE_KALD) await Promise.race(igang);
      if (fejl) break;
      await vent(pause);
      const i = nr - 2;
      const p = hentSide(nr).then(d => { svar[i + 1] = d; }, e => { fejl = fejl || e; }).finally(() => igang.delete(p));
      igang.add(p);
    }
    await Promise.all(igang);
    if (fejl) throw fejl;
    return svar.flatMap(d => d[felt] || []);
  }

  return {
    /** Ordrelinjer med ordredato i perioden (begge datoer inklusive, YYYY-MM-DD). */
    async ordrelinjer(fra, til, maxSider) {
      const params = { order_date_from: `${fra} 00:00:00`, order_date_to: `${til} 23:59:59` };
      const raa = [];
      for (const l of await alleSider('/orders/lines', 'order_lines', params, maxSider)) {
        const r = ordrelinjeTilRaa(l);
        if (r) raa.push(r);
      }
      return raa;
    },
    /** Lagerbeholdning (stock_quantity) pr. varenummer. */
    async lager(maxSider) {
      const lager = {};
      for (const p of await alleSider('/products', 'products', { fields: 'number,stock_quantity' }, maxSider)) {
        if (!p || typeof p.number !== 'string') throw new RackbeatFejl('uventet_svar');
        if (typeof p.stock_quantity === 'number' && Number.isFinite(p.stock_quantity)) lager[p.number] = p.stock_quantity;
      }
      return lager;
    },
  };
}

/** Skriveadgang: opretter og bogfører lagerreguleringer, der lægger et antal til beholdningen på Hovedlager.
 *  En regulering er en kladde, indtil den er bogført, og først da ændres beholdningen (afprøvet 9. november 2026).
 *  Med regulate_diff: false SÆTTER Rackbeat beholdningen til det sendte antal, når reguleringen bogføres
 *  (afprøvet 16. november 2026: 22 sendt ved 24 på lager gav -2). Rackbeats dokumentation beskriver ikke feltet.
 *  Derfor lægges til ved at læse beholdningen og sende nuværende + antal, og bagefter tjekkes det, at den bogførte
 *  ændring blev præcis +antal. Ingen genforsøg ved fejl. Dobbelt-registrering forhindres med referencen. */
export function lavSkriveKlient({ noegle, fetch: hent = globalThis.fetch, basisUrl = BASIS_URL }) {
  if (!noegle) throw new RackbeatFejl('ikke_sat_op');
  const hoveder = { Authorization: `Bearer ${noegle}`, Accept: 'application/json', 'Content-Type': 'application/json' };

  async function kald(metode, sti, krop, { tomtSvarOk = false } = {}) {
    let svar;
    try {
      svar = await hent(`${basisUrl}${sti}`, { method: metode, headers: hoveder, ...(krop ? { body: JSON.stringify(krop) } : {}) });
    } catch {
      throw new RackbeatFejl('ingen_forbindelse');
    }
    if (svar.status < 200 || svar.status > 299) throw new RackbeatFejl(KODER[svar.status] || 'rackbeat_fejl', svar.status);
    try {
      return await svar.json();
    } catch {
      if (tomtSvarOk) return null;
      throw new RackbeatFejl('uventet_svar', svar.status);
    }
  }

  const reguleringSti = id => `/inventory-adjustments/${encodeURIComponent(id)}`;
  async function hentRegulering(id) {
    const data = await kald('GET', reguleringSti(id));
    const r = data && (data.inventory_regulation || data);
    if (!r || typeof r !== 'object') throw new RackbeatFejl('uventet_svar');
    return r;
  }

  /** Beholdningen på Hovedlager lige nu */
  async function lagerPaaHovedlager(sku) {
    let data;
    try {
      data = await kald('GET', `/products/${encodeURIComponent(sku)}/locations`);
    } catch (e) {
      throw e instanceof RackbeatFejl && e.kode === 'ikke_fundet' ? new RackbeatFejl('ukendt_vare', e.status) : e;
    }
    const l = data && Array.isArray(data.product_locations) && data.product_locations.find(x => x && Number(x.number) === HOVEDLAGER);
    const n = l ? Number(l.stock_quantity) : NaN;
    if (!Number.isFinite(n)) throw new RackbeatFejl('uventet_svar');
    return n;
  }

  /** Bogfører reguleringen, så beholdningen ændres. 422 betyder måske "allerede bogført", så det tjekkes. */
  async function bogfoer(id) {
    try {
      await kald('POST', `${reguleringSti(id)}/book`, null, { tomtSvarOk: true });
    } catch (e) {
      if (!(e instanceof RackbeatFejl) || e.kode !== 'afvist_af_rackbeat') throw e;
      if ((await hentRegulering(id)).is_booked !== true) throw e;
    }
  }

  return {
    /** Finder en regulering med referencen i beskrivelsen. Rackbeats liste viser som standard kun kladder,
     *  så der søges i både bogførte og kladder, for varen og fra datoen. */
    async findRegulering(reference, { sku, dato }) {
      for (const bogfoert of [true, false]) {
        const q = new URLSearchParams({ is_booked: String(bogfoert), item_number: sku, date_from: dato, limit: 100, page: 1 });
        const data = await kald('GET', `/inventory-adjustments?${q}`);
        const liste = data && data.inventory_regulations;
        if (!Array.isArray(liste)) throw new RackbeatFejl('uventet_svar');
        const fundet = liste.find(r => r && typeof r.description === 'string' && r.description.includes(reference));
        if (fundet) return { id: fundet.id, bogfoert: fundet.is_booked === true };
      }
      return null;
    },
    /** Lægger antal stk. til på Hovedlager: læser beholdningen, opretter "sæt til nuværende + antal" og bogfører straks.
     *  Bagefter tjekkes den bogførte ændring. afviger er true, hvis den ikke blev præcis +antal (fx et salg i samme sekund). */
    async laegTil({ sku, antal, dato, aarsag, beskrivelse }) {
      const foer = await lagerPaaHovedlager(sku);
      const data = await kald('POST', '/inventory-adjustments', {
        regulated_at: dato,
        reason: aarsag,
        description: beskrivelse,
        adjustment_type: 'quantity',
        item_id: sku,
        location: HOVEDLAGER,
        quantity: String(foer + antal),
        regulation_type: KATEGORI_PRODUKTION,
        regulate_diff: false,
      });
      const r = data && (data.inventory_regulation || data.inventory_adjustment || data);
      if (!r || r.id == null) throw new RackbeatFejl('uventet_svar');
      await bogfoer(r.id);
      let aendring = null;
      try {
        const l = (await hentRegulering(r.id)).lines;
        aendring = Array.isArray(l) && l[0] ? Number(l[0].quantity) : null;
      } catch { /* bogført, men kunne ikke kontrolleres */ }
      return { id: r.id, foer, aendring, afviger: aendring !== null && aendring !== antal };
    },
    /** Sletter en kladde. En gammel kladde bogføres aldrig, for den sætter beholdningen ud fra lageret dengang. */
    async sletKladde(id) {
      if ((await hentRegulering(id)).is_booked === true) throw new RackbeatFejl('allerede_bogfoert');
      await kald('DELETE', reguleringSti(id), null, { tomtSvarOk: true });
    },
  };
}

/** Omsætter én ordrelinje til de fem felter, beregningen bruger. Kunde, priser og alt andet kasseres her.
 *  Annullerede ordrer giver null. Rackbeat har ingen salgskanal på ordrelinjerne. */
export function ordrelinjeTilRaa(l) {
  const ordre = (l && l.order) || {};
  if (ordre.status && ordre.status.is_cancelled) return null;
  return {
    dato: typeof ordre.order_date === 'string' ? ordre.order_date : null,
    sku: l && l.item && l.item.number != null ? String(l.item.number) : null,
    antal: l && l.quantities ? l.quantities.ordered : null,
    kanal: null,
    ordre_id: ordre.number != null ? String(ordre.number) : null,
  };
}
