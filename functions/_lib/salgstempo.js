// Salgstempo pr. varenummer. Oprindeligt porteret fra et Python-script (nu slettet) med samme regler.
// tests/salgstempo_paritet.test.mjs sammenligner med facit fra scriptet.
// Datoer regnes som dagnumre (dage siden 1970-01-01), så tidszoner ikke spiller ind.

const ENGANGS_KANALER = new Set(['event', 'b2b']);
const ENGANGS_FAKTOR = 3;          // Skøn: enkeltordrer over 3 × mediant ugesalg er engangsordrer
const SENESTE_UGER = 8;
const MIN_HELE_UGER_I_MAANED = 3;  // Skøn: færre hele uger giver et månedstal, der ikke kan bruges
const LAVT_SALG_MEDIAN = 3;        // Skøn: under denne median kan nuluger ikke skelnes fra normalt salg
const DAG_MS = 86400000;

export const dagNr = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAG_MS;
export const isoDato = n => new Date(n * DAG_MS).toISOString().slice(0, 10);
const ugedag = n => (new Date(n * DAG_MS).getUTCDay() + 6) % 7;   // mandag = 0
const maaned = n => new Date(n * DAG_MS).getUTCMonth() + 1;
const mandag = n => n - ugedag(n);

/** Mandag og søndag for de seneste hele uger før kørselsdatoen (som dagnumre). */
export function vindue(koerselsdato, uger = 52) {
  const k = dagNr(koerselsdato);
  const slut = k - (ugedag(k) + 1);
  return { start: slut - (7 * uger - 1), slut };
}

/** Rensning af rå ordrelinjer med samme regler som scriptet. Returnerer også sprungne linjer med årsag. */
export function normaliser(raa) {
  const linjer = [], sprunget = {};
  const spring = aarsag => { sprunget[aarsag] = (sprunget[aarsag] || 0) + 1; };
  const tom = v => v === null || v === undefined || String(v).trim() === '';
  for (const r of raa) {
    if (['dato', 'sku', 'antal', 'kanal', 'ordre_id'].every(k => tom(r[k]))) continue;
    if (tom(r.sku)) { spring('uden SKU (fragt, rabat)'); continue; }
    const antal = typeof r.antal === 'number' ? r.antal : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(r.antal ?? '')) ? Number(r.antal) : NaN);
    if (!Number.isFinite(antal)) { spring('ugyldigt antal'); continue; }
    if (antal < 0) { spring('negativt antal (kreditnota, retur)'); continue; }
    if (antal === 0) { spring('antal er 0'); continue; }
    // Kun datodelen bruges, som i scriptet (ordredatoen uden klokkeslæt)
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(r.dato ?? '').trim());
    if (!m || isNaN(Date.UTC(+m[1], +m[2] - 1, +m[3])) || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) { spring('ugyldig dato'); continue; }
    linjer.push({
      dag: dagNr(m[0]), sku: String(r.sku).trim(), antal,
      kanal: tom(r.kanal) ? null : String(r.kanal).trim(),
      ordre_id: tom(r.ordre_id) ? null : String(r.ordre_id).trim(),
    });
  }
  return { linjer, sprunget };
}

function median(tal) {
  if (!tal.length) return NaN;
  const s = [...tal].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Salg pr. uge fra start til slut. Uger uden salg tæller som 0. */
function ugesalg(linjer, start, slut) {
  const uger = [];
  for (let u = start; u <= slut; u += 7) uger.push(0);
  for (const l of linjer) {
    const i = (mandag(l.dag) - start) / 7;
    if (i >= 0 && i < uger.length) uger[i] += l.antal;
  }
  return uger;
}

/** Markerer linjer fra kanalerne event og b2b og enkeltordrer over grænsen. */
function findEngangsordrer(linjer, start, slut) {
  const fraKanal = linjer.map(l => ENGANGS_KANALER.has((l.kanal || '').trim().toLowerCase()));
  const uger = ugesalg(linjer.filter((_, i) => !fraKanal[i]), start, slut);
  let med = median(uger);
  if (med === 0) {
    // Sjældent solgte varer har median 0, og så ville alle ordrer blive engangsordrer
    const medSalg = uger.filter(v => v > 0);
    med = medSalg.length ? median(medSalg) : 0;
  }
  // Uden ordrenummer behandles hver linje som sin egen ordre
  const ordre = linjer.map((l, i) => l.ordre_id ?? `\u0000linje${i}`);
  const prOrdre = new Map();
  linjer.forEach((l, i) => { if (!fraKanal[i]) prOrdre.set(ordre[i], (prOrdre.get(ordre[i]) || 0) + l.antal); });
  const maske = linjer.map((_, i) => fraKanal[i] || prOrdre.get(ordre[i]) > ENGANGS_FAKTOR * med);
  return { maske, antal: new Set(ordre.filter((_, i) => maske[i])).size };
}

/** Ugentligt salg pr. kalendermåned. null for måneder uden salg eller med for få hele uger. Start skal være en mandag. */
function maanedligtTempo(linjer, start, slut) {
  const dage = Array(13).fill(0), heleUger = Array(13).fill(0), solgt = Array(13).fill(0);
  for (let d = start; d <= slut; d++) dage[maaned(d)]++;
  for (let u = start; u <= slut; u += 7) if (maaned(u) === maaned(u + 6)) heleUger[maaned(u)]++;
  for (const l of linjer) solgt[maaned(l.dag)] += l.antal;
  const ud = [];
  for (let m = 1; m <= 12; m++) {
    ud.push(heleUger[m] >= MIN_HELE_UGER_I_MAANED && solgt[m] > 0 ? solgt[m] / dage[m] * 7 : null);
  }
  return ud;
}

/** Sand ved 2 eller flere uger i træk med 0 salg efter en periode med salg. */
export function muligtUdsolgt(uger, harSolgtFoer) {
  let harSolgt = harSolgtFoer, nuller = 0;
  for (const v of uger) {
    if (v > 0) { harSolgt = true; nuller = 0; }
    else if (harSolgt && ++nuller >= 2) return true;
  }
  return false;
}

/** Grænserne står i README.md. */
export function sikkerhed(ugerMedSalg, variation) {
  if (ugerMedSalg < 12 || variation === null || variation > 1.2) return 'lav';
  if (ugerMedSalg >= 40 && variation < 0.6) return 'høj';
  return 'middel';
}

const tomtResultat = (uger, flag) => ({
  rate: null, maanedlig: Array(12).fill(null), seneste8: null, vindue_uger: uger, sikkerhed: 'lav', flag,
  engangsordrer_antal: 0, engangsordrer_stk: 0, uger_i_beregning: 0, uger_med_salg: 0, variationskoefficient: null,
});

const sum = tal => tal.reduce((a, b) => a + b, 0);

/** Alle nøgletal for ét varenummer. linjer må gerne gå længere tilbage end vinduet. */
export function beregnSku(alleLinjer, start, slut, uger) {
  const linjer = alleLinjer.filter(l => l.dag <= slut);
  const iVindue = linjer.filter(l => l.dag >= start);
  if (!iVindue.length) return tomtResultat(uger, ['ingen_salg']);

  // Første salg afgør, hvor beregningen begynder. Engangsordrer tæller også som salg her.
  const foerste = Math.min(...linjer.map(l => l.dag));
  const aktivStart = Math.max(start, mandag(foerste));

  const { maske, antal: engangsAntal } = findEngangsordrer(iVindue, aktivStart, slut);
  const grund = iVindue.filter((_, i) => !maske[i]);
  const engangsStk = sum(iVindue.filter((_, i) => maske[i]).map(l => l.antal));

  const alleUger = ugesalg(iVindue, aktivStart, slut);
  const grundUger = ugesalg(grund, aktivStart, slut);
  const n = grundUger.length;
  const rate = sum(grundUger) / n;
  const spredning = Math.sqrt(sum(grundUger.map(v => (v - rate) ** 2)) / n);
  const variation = rate > 0 ? spredning / rate : null;
  const ugerMedSalg = grundUger.filter(v => v > 0).length;
  const maanedlig = maanedligtTempo(grund, aktivStart, slut);

  const flag = [];
  if (aktivStart > start) flag.push('kort_historik');
  if (maanedlig.some(v => v === null)) flag.push('ufuldstaendig_saeson');
  const salgsuger = grundUger.filter(v => v > 0);
  if (!salgsuger.length || median(salgsuger) < LAVT_SALG_MEDIAN) flag.push('lavt_salg');
  // Alle salg tæller her: en uge med kun en engangsordre viser, at der var varer på lager
  else if (muligtUdsolgt(alleUger, foerste < start)) flag.push('muligt_udsolgt');
  if (rate === 0) flag.push('kun_engangsordrer');

  const seneste = grundUger.slice(-SENESTE_UGER);
  return {
    rate, maanedlig, seneste8: sum(seneste) / seneste.length, vindue_uger: uger,
    sikkerhed: sikkerhed(ugerMedSalg, variation), flag,
    engangsordrer_antal: engangsAntal, engangsordrer_stk: engangsStk,
    uger_i_beregning: n, uger_med_salg: ugerMedSalg, variationskoefficient: variation,
  };
}

/** Beregner alle varenumre i linjerne. Linjerne bør indeholde historik fra før vinduet. */
export function beregnAlle(linjer, koerselsdato, uger = 52) {
  const { start, slut } = vindue(koerselsdato, uger);
  const prSku = new Map();
  for (const l of linjer) {
    if (!prSku.has(l.sku)) prSku.set(l.sku, []);
    prSku.get(l.sku).push(l);
  }
  const ud = {};
  for (const sku of [...prSku.keys()].sort()) ud[sku] = beregnSku(prSku.get(sku), start, slut, uger);
  return ud;
}

/** Felterne, V2 bruger. Uden løbende salg er der intet tempo, og produktet kommer ikke med. */
export function tilKlient(resultater, koerselsdato) {
  const ud = {};
  for (const [sku, r] of Object.entries(resultater)) {
    if (!r.rate) continue;
    ud[sku] = {
      rate: r.rate, maanedlig: r.maanedlig, seneste8: r.seneste8, beregnet: koerselsdato,
      vindue_uger: r.vindue_uger, sikkerhed: r.sikkerhed, flag: r.flag,
      engangsordrer_antal: r.engangsordrer_antal, engangsordrer_stk: r.engangsordrer_stk,
    };
  }
  return ud;
}
