// Adgang til Rackbeat. Læsning (lavKlient) er kun GET. Skrivning (lavSkriveKlient) er kun lagerreguleringer,
// der lægger et antal til beholdningen. Kun faste endpoints, og kun de felter, kalenderen bruger.
// Kilde: developer.rackbeat.com (Authentication, Pagination, Errors & Rate Limits, "List Lines for all Orders",
// "List Products" og "Create Inventory Adjustment"), slået op november 2026.

const BASIS_URL = 'https://app.rackbeat.com/api';
const PR_SIDE = 100;           // Dokumentationen nævner ingen øvre grænse; sidetallet læses fra svaret
const PAUSE_MELLEM_SIDER = 150; // ms. Holder os under 480 kald i minuttet pr. konto

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

  /** Henter alle sider. Stopper med fejl i stedet for at returnere en halv historik. */
  async function alleSider(sti, felt, params, maxSider) {
    const poster = [];
    for (let nr = 1, sider = 1; nr <= sider; nr++) {
      if (nr > 1) await vent(pause);
      const data = await side(sti, { ...params, limit: PR_SIDE, page: nr });
      if (!data || typeof data !== 'object' || (data[felt] !== undefined && !Array.isArray(data[felt]))) {
        throw new RackbeatFejl('uventet_svar');
      }
      sider = Number.isInteger(data.pages) ? data.pages : 0;
      if (sider > maxSider) throw new RackbeatFejl('for_mange_sider');
      const del = data[felt] || [];
      poster.push(...del);
      if (!del.length) break;
    }
    return poster;
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

/** Skriveadgang: opretter og bogfører lagerreguleringer, der lægger et antal til beholdningen. En regulering er
 *  en kladde, indtil den er bogført, og først da ændres beholdningen (afprøvet mod Rackbeat 9. november 2026).
 *  Ingen genforsøg ved fejl, for et POST, der måske er gået igennem, må ikke sendes igen.
 *  Dobbelt-registrering forhindres med referencen. */
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

  return {
    /** Finder en regulering med referencen i beskrivelsen blandt de nyeste (Rackbeat viser nyeste først). */
    async findRegulering(reference) {
      const data = await kald('GET', `/inventory-adjustments?${new URLSearchParams({ limit: 100, page: 1 })}`);
      const liste = data && data.inventory_regulations;
      if (!Array.isArray(liste)) throw new RackbeatFejl('uventet_svar');
      const fundet = liste.find(r => r && typeof r.description === 'string' && r.description.includes(reference));
      return fundet ? { id: fundet.id, bogfoert: fundet.is_booked === true } : null;
    },
    /** Lægger antal stk. af varen til på Hovedlager. regulate_diff: false betyder "læg til", ikke "sæt til". */
    async lagerregulering({ sku, antal, dato, aarsag, beskrivelse }) {
      const data = await kald('POST', '/inventory-adjustments', {
        regulated_at: dato,
        reason: aarsag,
        description: beskrivelse,
        adjustment_type: 'quantity',
        item_id: sku,
        location: HOVEDLAGER,
        quantity: String(antal),
        regulation_type: KATEGORI_PRODUKTION,
        regulate_diff: false,
      });
      const r = data && (data.inventory_regulation || data.inventory_adjustment || data);
      if (!r || r.id == null) throw new RackbeatFejl('uventet_svar');
      return { id: r.id };
    },
    /** Bogfører reguleringen, så beholdningen ændres. 422 betyder måske "allerede bogført", så det tjekkes. */
    async bogfoer(id) {
      try {
        await kald('POST', `/inventory-adjustments/${encodeURIComponent(id)}/book`, null, { tomtSvarOk: true });
      } catch (e) {
        if (!(e instanceof RackbeatFejl) || e.kode !== 'afvist_af_rackbeat') throw e;
        const data = await kald('GET', `/inventory-adjustments/${encodeURIComponent(id)}`);
        const r = data && (data.inventory_regulation || data);
        if (!r || r.is_booked !== true) throw e;
      }
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
