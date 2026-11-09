// Gemmer det seneste gode svar i serverinstansens hukommelse. Vercel genbruger en instans til flere kald,
// men har ikke en fælles cache mellem instanser, så hver instans henter selv fra Rackbeat.
// Friskheden afgøres af tidspunktet i posten, så en gammel post stadig kan sendes som forældet,
// når Rackbeat ikke svarer.

const hukommelse = new Map();
const igang = new Map();

export async function laes(_origin, navn) {
  return hukommelse.get(navn) || null;
}

/** Gemmer kun, hvis posten er mindst lige så ny som den gemte. Så kan en langsom hentning, der startede
 *  før en nyere, ikke overskrive den nyere i cachen. */
export async function gem(_origin, navn, post) {
  const gemt = hukommelse.get(navn);
  if (!gemt || post.hentet >= gemt.hentet) hukommelse.set(navn, post);
}

/** Kører kun én opdatering ad gangen pr. navn i denne instans. */
export function enAdGangen(navn, opgave) {
  if (!igang.has(navn)) igang.set(navn, opgave().finally(() => igang.delete(navn)));
  return igang.get(navn);
}

/** Kun til test. */
export function _nulstil() { hukommelse.clear(); igang.clear(); }
