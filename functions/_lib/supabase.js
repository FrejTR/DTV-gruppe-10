// Adgang til de fælles data i Supabase. Kun serveren taler med databasen, med den hemmelige nøgle
// (SUPABASE_SECRET_KEY). Kun de faste funktioner i supabase/migrations kaldes (POST /rest/v1/rpc/<navn>).

const FUNKTIONER = new Set(['hent_data', 'gem_data', 'reserver_pakning', 'bekraeft_pakning', 'annuller_pakning', 'log_historik', 'hent_historik']);
// Fejl, funktionerne selv rejser (raise exception). Alle andre fejl fra databasen er db_fejl.
const KENDTE = new Set(['ikke_nok_klar', 'ugyldig_pakning', 'ukendt_pakning']);

export class DataFejl extends Error {
  /** kode er kort og generisk, så den kan vises i appen. detalje er fx antallet, der er klar. */
  constructor(kode, status = null, detalje = null) {
    super(kode);
    this.kode = kode;
    this.status = status;
    this.detalje = detalje;
  }
}

export function lavDataKlient({ url, noegle, fetch: hent = globalThis.fetch }) {
  if (!url || !noegle) throw new DataFejl('db_ikke_sat_op');
  const basis = String(url).replace(/\/+$/, '');

  return {
    async rpc(navn, p = {}) {
      if (!FUNKTIONER.has(navn)) throw new DataFejl('db_fejl');
      let svar;
      try {
        svar = await hent(`${basis}/rest/v1/rpc/${navn}`, {
          method: 'POST',
          headers: { apikey: noegle, Authorization: `Bearer ${noegle}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ p }),
        });
      } catch {
        throw new DataFejl('db_ingen_forbindelse');
      }
      let krop = null;
      try { krop = await svar.json(); } catch { /* håndteres herunder */ }
      if (svar.status === 401 || svar.status === 403) throw new DataFejl('db_noegle_afvist', svar.status);
      if (svar.status < 200 || svar.status > 299) {
        const besked = krop && typeof krop.message === 'string' ? krop.message : '';
        if (KENDTE.has(besked)) throw new DataFejl(besked, svar.status, krop.details ?? null);
        throw new DataFejl('db_fejl', svar.status);
      }
      if (krop === null || typeof krop !== 'object') throw new DataFejl('db_fejl', svar.status);
      return krop;
    },
  };
}
