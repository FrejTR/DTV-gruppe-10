"""Beregner salgstempo pr. produkt ud fra ordrehistorik.

Kørsel: python scripts/beregn_salgstempo.py --fil data/ordrehistorik.xlsx --uger 52
Eller direkte fra Rackbeat: python scripts/beregn_salgstempo.py --rackbeat (kræver RACKBEAT_API_KEY)
Antagelserne bag beregningen står i README.md.
"""
import argparse
import csv
import json
import re
import statistics
import sys
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pandas as pd

from ordrekilder import InputFejl, fil_kilde, laes_kolonner, rackbeat_kilde

ROD = Path(__file__).resolve().parent.parent
ENGANGS_KANALER = {"event", "b2b"}
ENGANGS_FAKTOR = 3  # Skøn: enkeltordrer over 3 × mediant ugesalg er engangsordrer
SENESTE_UGER = 8
MIN_HELE_UGER_I_MAANED = 3  # Skøn: færre hele uger giver et månedstal, der ikke kan bruges
LAVT_SALG_MEDIAN = 3  # Skøn: under denne median kan nuluger ikke skelnes fra normalt salg
MAANEDER = ("jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec")


def vindue(koerselsdato, uger=52):
    """Returnerer (mandag, søndag) for de seneste hele uger før kørselsdatoen."""
    slut = koerselsdato - timedelta(days=koerselsdato.weekday() + 1)
    start = slut - timedelta(days=7 * uger - 1)
    return start, slut


def mandag(datoer):
    return datoer - pd.to_timedelta(datoer.dt.weekday, unit="D")


def ugesalg(linjer, start, slut):
    """Salg pr. uge fra start til slut. Uger uden salg tæller som 0."""
    uger = pd.date_range(start, slut, freq="7D")
    if linjer.empty:
        return pd.Series(0.0, index=uger)
    return linjer.groupby(mandag(linjer["dato"]))["antal"].sum().reindex(uger, fill_value=0.0)


def find_engangsordrer(linjer, start, slut):
    """Markerer linjer fra kanalerne event og b2b og enkeltordrer over grænsen."""
    kanal = linjer["kanal"].fillna("").str.strip().str.casefold()
    fra_kanal = kanal.isin(ENGANGS_KANALER)
    uger = ugesalg(linjer[~fra_kanal], start, slut)
    median = uger.median()
    if median == 0:
        # Sjældent solgte varer har median 0, og så ville alle ordrer blive engangsordrer
        median = uger[uger > 0].median() if (uger > 0).any() else 0
    # Uden ordrenummer behandles hver linje som sin egen ordre
    ordre = linjer["ordre_id"].where(linjer["ordre_id"].notna(), linjer.index.to_series().astype(str))
    pr_ordre = linjer[~fra_kanal].groupby(ordre[~fra_kanal])["antal"].transform("sum")
    for_stor = pr_ordre > ENGANGS_FAKTOR * median
    maske = fra_kanal.copy()
    maske.loc[for_stor[for_stor].index] = True
    return maske, ordre[maske].nunique()


def maanedligt_tempo(linjer, start, slut):
    """Gennemsnitligt ugentligt salg pr. kalendermåned.

    None for måneder uden salg eller med for få hele uger (mandag–søndag) i perioden.
    Start skal være en mandag.
    """
    dage_pr_maaned = pd.Series(pd.date_range(start, slut).month).value_counts()
    mandage = pd.date_range(start, slut, freq="7D")
    hele_uger = mandage[mandage.month == (mandage + pd.Timedelta(days=6)).month]
    uger_pr_maaned = pd.Series(hele_uger.month).value_counts()
    solgt = linjer.groupby(linjer["dato"].dt.month)["antal"].sum() if not linjer.empty else {}
    return [
        solgt[m] / dage_pr_maaned[m] * 7
        if uger_pr_maaned.get(m, 0) >= MIN_HELE_UGER_I_MAANED and m in solgt and solgt[m] > 0 else None
        for m in range(1, 13)
    ]


def muligt_udsolgt(uger, har_solgt_foer):
    """Sand ved 2 eller flere uger i træk med 0 salg efter en periode med salg."""
    har_solgt, nuller = har_solgt_foer, 0
    for v in uger:
        if v > 0:
            har_solgt, nuller = True, 0
        elif har_solgt:
            nuller += 1
            if nuller >= 2:
                return True
    return False


def sikkerhed(uger_med_salg, variation):
    """Grænserne står i README.md."""
    if uger_med_salg < 12 or variation is None or variation > 1.2:
        return "lav"
    if uger_med_salg >= 40 and variation < 0.6:
        return "høj"
    return "middel"


def tomt_resultat(uger, flag):
    return {"rate": None, "maanedlig": [None] * 12, "seneste8": None, "vindue_uger": uger,
            "sikkerhed": "lav", "flag": flag, "engangsordrer_antal": 0, "engangsordrer_stk": 0,
            "uger_i_beregning": 0, "uger_med_salg": 0, "variationskoefficient": None}


def beregn_sku(linjer, start, slut, uger):
    """Beregner alle nøgletal for ét produkt. linjer må gerne gå længere tilbage end vinduet."""
    start_ts, slut_ts = pd.Timestamp(start), pd.Timestamp(slut)
    linjer = linjer[linjer["dato"] <= slut_ts]
    i_vindue = linjer[linjer["dato"] >= start_ts]
    if i_vindue.empty:
        return tomt_resultat(uger, ["ingen_salg"])

    # Første salg afgør, hvor beregningen begynder. Engangsordrer tæller også som salg her.
    foerste = linjer["dato"].min()
    foerste_uge = foerste - pd.Timedelta(days=foerste.weekday())
    aktiv_start = max(start_ts, foerste_uge)
    kort_historik = aktiv_start > start_ts

    engangs, engangs_antal = find_engangsordrer(i_vindue, aktiv_start, slut_ts)
    grund = i_vindue[~engangs]
    engangs_stk = i_vindue.loc[engangs, "antal"].sum()

    alle_uger = ugesalg(i_vindue, aktiv_start, slut_ts)
    grund_uger = ugesalg(grund, aktiv_start, slut_ts)
    uger_i_beregning = len(grund_uger)
    rate = grund_uger.sum() / uger_i_beregning
    gennemsnit = grund_uger.mean()
    variation = float(grund_uger.std(ddof=0) / gennemsnit) if gennemsnit > 0 else None
    uger_med_salg = int((grund_uger > 0).sum())
    maanedlig = maanedligt_tempo(grund, aktiv_start, slut_ts)

    flag = []
    if kort_historik:
        flag.append("kort_historik")
    if any(v is None for v in maanedlig):
        flag.append("ufuldstaendig_saeson")
    salgsuger = grund_uger[grund_uger > 0]
    if salgsuger.empty or salgsuger.median() < LAVT_SALG_MEDIAN:
        flag.append("lavt_salg")
    # Alle salg tæller her: en uge med kun en engangsordre viser, at der var varer på lager
    elif muligt_udsolgt(alle_uger, foerste < start_ts):
        flag.append("muligt_udsolgt")
    if rate == 0:
        flag.append("kun_engangsordrer")

    return {
        "rate": float(rate),
        "maanedlig": [None if v is None else float(v) for v in maanedlig],
        "seneste8": float(grund_uger.tail(SENESTE_UGER).mean()),
        "vindue_uger": uger,
        "sikkerhed": sikkerhed(uger_med_salg, variation),
        "flag": flag,
        "engangsordrer_antal": int(engangs_antal),
        "engangsordrer_stk": float(engangs_stk),
        "uger_i_beregning": uger_i_beregning,
        "uger_med_salg": uger_med_salg,
        "variationskoefficient": variation,
    }


def beregn_alle(linjer, koerselsdato, uger=52):
    """Beregner alle SKU'er i linjerne. Linjerne skal indeholde historik fra før vinduet."""
    start, slut = vindue(koerselsdato, uger)
    return {sku: beregn_sku(gruppe, start, slut, uger) for sku, gruppe in linjer.groupby("sku")}


def laes_v2_produkter(sti):
    """Læser SKU, navn og nuværende rate fra V2's eksempeldata, så listen kun findes ét sted."""
    sti = Path(sti)
    if not sti.exists():
        raise InputFejl(f"V2-filen {sti} findes ikke.")
    moenster = re.compile(r"P\('[^']*','([^']*)','[^']*',[\d.]+,([\d.]+),[\d.]+,[\d.]+,'([^']+)'")
    produkter = {sku: {"navn": navn, "rate": float(rate)}
                 for navn, rate, sku in moenster.findall(sti.read_text(encoding="utf-8"))}
    if not produkter:
        raise InputFejl(f"Fandt ingen produkter i {sti}. Er formatet på produktlisten ændret?")
    return produkter


def afvigelse_pct(estimat, beregnet):
    if not estimat or beregnet is None:
        return None
    return (beregnet - estimat) / estimat * 100


def saml_resultater(linjer, produkter, koerselsdato, uger):
    """Lægger V2-produkter uden salg til og sætter dato og sammenligning på."""
    resultater = beregn_alle(linjer, koerselsdato, uger)
    for sku in produkter:
        resultater.setdefault(sku, tomt_resultat(uger, ["ingen_salg"]))
    raekkefoelge = [s for s in produkter] + sorted(s for s in resultater if s not in produkter)
    ud = {}
    for sku in raekkefoelge:
        r = dict(resultater[sku])
        r["beregnet"] = koerselsdato.isoformat()
        estimat = produkter[sku]["rate"] if sku in produkter else None
        r["estimat_nu"] = estimat
        r["afvigelse_pct"] = afvigelse_pct(estimat, r["rate"])
        ud[sku] = r
    return ud


def kan_importeres(r):
    # Uden løbende salg er der ikke noget tempo. Rate 0 ville få kalenderen til at
    # tro, at lageret aldrig løber tør, så V2 beholder i stedet sit estimat.
    return bool(r["rate"])


def skriv_json(resultater, sti):
    felter = ("rate", "maanedlig", "seneste8", "beregnet", "vindue_uger", "sikkerhed", "flag",
              "engangsordrer_antal", "engangsordrer_stk")
    data = {sku: {f: r[f] for f in felter} for sku, r in resultater.items() if kan_importeres(r)}
    Path(sti).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _dk(tal):
    return "" if tal is None else str(tal).replace(".", ",")


def skriv_csv(resultater, sti, produkter):
    """Dansk CSV til Excel. I CSV'en er beregnet tempoet, og datoen hedder beregnet_dato."""
    hoved = ["sku", "navn", "estimat_nu", "beregnet", "afvigelse_pct", "rate", "seneste8",
             *[f"maaned_{m}" for m in MAANEDER], "beregnet_dato", "vindue_uger", "uger_i_beregning",
             "uger_med_salg", "variationskoefficient", "sikkerhed", "flag",
             "engangsordrer_antal", "engangsordrer_stk"]
    with open(sti, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(hoved)
        for sku, r in resultater.items():
            w.writerow([sku, produkter.get(sku, {}).get("navn", ""), _dk(r["estimat_nu"]), _dk(r["rate"]),
                        _dk(r["afvigelse_pct"]), _dk(r["rate"]), _dk(r["seneste8"]),
                        *[_dk(v) for v in r["maanedlig"]], r["beregnet"], r["vindue_uger"],
                        r["uger_i_beregning"], r["uger_med_salg"], _dk(r["variationskoefficient"]),
                        r["sikkerhed"], ", ".join(r["flag"]), r["engangsordrer_antal"],
                        _dk(r["engangsordrer_stk"])])


def daekningsadvarsler(linjer, start, slut):
    """Advarer, hvis filen ikke dækker vinduet. Ellers ligner manglende data et fald i salget."""
    if linjer.empty:
        return []
    ud = []
    foerst, sidst = linjer["dato"].min().date(), linjer["dato"].max().date()
    if foerst > start + timedelta(days=7):
        ud.append(f"Filen begynder {foerst}, men vinduet begynder {start}. Alle produkter kan få flaget kort_historik.")
    if sidst < slut - timedelta(days=7):
        ud.append(f"Filen slutter {sidst}, men vinduet slutter {slut}. Uger uden data tæller som 0, så tempoet bliver for lavt.")
    return ud


def vis_tal(tal, decimaler=2):
    """Afrunder kun til visning, med almindelig afrunding: 0,625 bliver 0,63."""
    if tal is None:
        return "–"
    afrundet = Decimal(repr(float(tal))).quantize(Decimal(1).scaleb(-decimaler), rounding=ROUND_HALF_UP)
    return str(afrundet).replace(".", ",")


def tekstrapport(resultater, produkter, sprunget, advarsler, start, slut, uden_for_vindue):
    t = [f"Salgstempo for {start} til {slut}", ""]
    t.append(f"{'SKU':<9} {'Produkt':<26} {'Estimat':>7} {'Beregnet':>8} {'Afv. %':>7} {'Sen. 8':>7} {'Sikkerhed':<9} {'Engangs':>7}  Flag")
    for sku, r in resultater.items():
        navn = produkter.get(sku, {}).get("navn", "(ikke i V2)")
        engangs = f"{r['engangsordrer_stk']:g}" if r["engangsordrer_antal"] else "–"
        t.append(f"{sku:<9} {navn:<26} {vis_tal(r['estimat_nu']):>7} {vis_tal(r['rate']):>8} {vis_tal(r['afvigelse_pct'], 1):>7} "
                 f"{vis_tal(r['seneste8']):>7} {r['sikkerhed']:<9} {engangs:>7}  {', '.join(r['flag'])}")

    t.append("")
    lav = [s for s, r in resultater.items() if r["sikkerhed"] == "lav" and s in produkter]
    flagede = [s for s, r in resultater.items() if r["flag"] and s in produkter]
    t.append(f"Lav sikkerhed: {', '.join(lav) or 'ingen'}")
    t.append(f"Med flag: {', '.join(flagede) or 'ingen'}")
    t.append(f"SKU'er i filen, som ikke findes i V2: {', '.join(s for s in resultater if s not in produkter) or 'ingen'}")
    uden_salg = [s for s in produkter if not kan_importeres(resultater[s])]
    t.append(f"V2-produkter uden løbende salg i vinduet: {', '.join(uden_salg) or 'ingen'}"
             + (" (kommer ikke med i JSON, så V2 beholder estimatet)" if uden_salg else ""))

    t.append("")
    t.append(f"Sprunget over: {sum(sprunget.values())} linjer")
    for aarsag, antal in sprunget.most_common():
        t.append(f"  {antal:>5}  {aarsag}")
    t.append(f"Uden for vinduet (ikke i tempoet): {uden_for_vindue} linjer")
    if advarsler:
        t.append("")
        t.extend(f"ADVARSEL: {a}" for a in advarsler)
    return "\n".join(t)


def koer(fil, uger, kolonner_sti, v2_sti, ud_mappe, koerselsdato, kilde=None):
    """Bruger filen, eller kilden (fx Rackbeat), hvis den er givet."""
    if uger < 1:
        raise InputFejl("--uger skal være mindst 1.")
    produkter = laes_v2_produkter(v2_sti)
    if kilde is None:
        kilde = fil_kilde(fil, laes_kolonner(kolonner_sti))
    start, slut = vindue(koerselsdato, uger)
    # Hele historikken hentes, fordi første salg kan ligge før vinduet
    linjer = kilde.hent_ordrelinjer(None, None)
    uden_for = int(((linjer["dato"] < pd.Timestamp(start)) | (linjer["dato"] > pd.Timestamp(slut))).sum())

    advarsler = list(kilde.advarsler) + daekningsadvarsler(linjer, start, slut)
    if linjer.empty:
        advarsler.append("Ingen brugbare ordrelinjer i filen. JSON-filen bliver tom.")
    resultater = saml_resultater(linjer, produkter, koerselsdato, uger)

    ud_mappe = Path(ud_mappe)
    ud_mappe.mkdir(parents=True, exist_ok=True)
    skriv_json(resultater, ud_mappe / "salgstempo.json")
    skriv_csv(resultater, ud_mappe / "salgstempo.csv", produkter)
    print(tekstrapport(resultater, produkter, kilde.sprunget, advarsler, start, slut, uden_for))
    print(f"\nSkrevet: {ud_mappe / 'salgstempo.json'} og {ud_mappe / 'salgstempo.csv'}")
    return resultater


def main(argv=None):
    p = argparse.ArgumentParser(description="Beregner salgstempo pr. produkt ud fra ordrehistorik.")
    k = p.add_mutually_exclusive_group(required=True)
    k.add_argument("--fil", help="CSV- eller XLSX-fil med ordrelinjer")
    k.add_argument("--rackbeat", action="store_true", help="hent ordrelinjer fra Rackbeat (nøgle i RACKBEAT_API_KEY)")
    p.add_argument("--uger", type=int, default=52, help="antal hele uger i vinduet (standard 52)")
    p.add_argument("--kolonner", default=ROD / "config" / "kolonner.json", help="kolonnemapping (JSON)")
    p.add_argument("--v2", default=ROD / "src" / "v2" / "produktionskalender-v2.html", help="V2's HTML-fil")
    p.add_argument("--ud", default=ROD / "output", help="mappe til output")
    p.add_argument("--dato", type=date.fromisoformat, default=None, help="kørselsdato (YYYY-MM-DD), standard i dag")
    a = p.parse_args(argv)
    try:
        kilde = rackbeat_kilde() if a.rackbeat else None
        koer(a.fil, a.uger, a.kolonner, a.v2, a.ud, a.dato or date.today(), kilde)
    except InputFejl as e:
        print(f"FEJL: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
