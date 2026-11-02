"""Ordrekilder til salgstempo-beregningen.

Alle kilder har samme interface: hent_ordrelinjer(fra_dato, til_dato) returnerer
en DataFrame med kolonnerne dato, sku, antal, kanal og ordre_id. Beregningen kender
kun det interface, så filen senere kan skiftes ud med Rackbeat-API'en.
"""
import io
import json
import os
import re
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pandas as pd

PAAKRAEVEDE = ("dato", "sku", "antal")
VALGFRIE = ("kanal", "ordre_id")
DATOFORMATER = ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d.%m.%Y", "%d-%m-%y")


class InputFejl(Exception):
    """Fejl i input, som brugeren selv kan rette. Vises uden traceback."""


def er_tom(vaerdi):
    if vaerdi is None:
        return True
    if isinstance(vaerdi, float) and pd.isna(vaerdi):
        return True
    return str(vaerdi).strip() == ""


def parse_tal(vaerdi):
    """Læser tal i dansk eller engelsk notation. Returnerer None, hvis det ikke er et tal."""
    if isinstance(vaerdi, bool) or er_tom(vaerdi):
        return None
    if isinstance(vaerdi, (int, float)):
        return float(vaerdi)
    t = str(vaerdi).strip().replace("−", "-").replace(" ", "").replace(" ", "")
    fortegn = 1
    if t.startswith("(") and t.endswith(")"):
        fortegn, t = -1, t[1:-1]
    elif t.endswith("-"):
        fortegn, t = -1, t[:-1]
    elif t.startswith("-"):
        fortegn, t = -1, t[1:]
    elif t.startswith("+"):
        t = t[1:]
    if "," in t and "." in t:
        # Det sidste skilletegn er decimaltegnet
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        t = t.replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", t):
        # Dansk tusindtalsskilletegn: 1.234 er 1234
        t = t.replace(".", "")
    if not re.fullmatch(r"\d+(\.\d+)?", t):
        return None
    return fortegn * float(t)


def parse_dato(vaerdi):
    """Læser danske datoformater og Excel-datoer. Returnerer None, hvis det ikke er en dato."""
    if er_tom(vaerdi):
        return None
    if isinstance(vaerdi, (datetime, date)):
        return pd.Timestamp(vaerdi).normalize()
    t = re.split(r"[ T]", str(vaerdi).strip())[0]
    for fmt in DATOFORMATER:
        try:
            return pd.Timestamp(datetime.strptime(t, fmt))
        except ValueError:
            continue
    return None


def laes_kolonner(sti):
    """Læser kolonnemappingen og tjekker, at de påkrævede felter er udfyldt."""
    sti = Path(sti)
    if not sti.exists():
        raise InputFejl(f"Kolonnemappingen {sti} findes ikke.")
    try:
        kolonner = json.loads(sti.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise InputFejl(f"{sti} er ikke gyldig JSON: {e}") from e
    mangler = [k for k in PAAKRAEVEDE if not kolonner.get(k)]
    if mangler:
        raise InputFejl(f"{sti} mangler mapping for: {', '.join(mangler)}.")
    return kolonner


def _laes_csv(sti):
    raa = Path(sti).read_bytes()
    try:
        tekst = raa.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Dansk Excel gemmer CSV i Windows-1252
        tekst = raa.decode("cp1252")
    linjer = [l for l in tekst.splitlines() if l.strip()]
    if not linjer:
        raise InputFejl(f"Filen {sti} er tom.")
    skilletegn = ";" if linjer[0].count(";") >= linjer[0].count(",") and ";" in linjer[0] else ","
    try:
        return pd.read_csv(io.StringIO(tekst), sep=skilletegn, dtype=str, keep_default_na=False)
    except pd.errors.ParserError as e:
        raise InputFejl(f"Kunne ikke læse {sti} som CSV med skilletegn '{skilletegn}': {e}") from e


def laes_fil(sti):
    """Læser CSV eller XLSX. Filtypen afgøres af filens indhold, ikke af navnet."""
    sti = Path(sti)
    if not sti.exists():
        raise InputFejl(f"Filen {sti} findes ikke.")
    with sti.open("rb") as f:
        er_xlsx = f.read(4) == b"PK\x03\x04"
    if er_xlsx:
        try:
            return pd.read_excel(sti, dtype=object, engine="openpyxl")
        except ValueError as e:
            raise InputFejl(f"Kunne ikke læse {sti} som XLSX: {e}") from e
    return _laes_csv(sti)


def normaliser(raa, kolonner):
    """Omsætter en rå tabel til ordrelinjer og tæller sprungne linjer med årsag."""
    raa = raa.rename(columns=lambda c: str(c).strip())
    fundne = {c.casefold(): c for c in raa.columns}
    find = lambda navn: fundne.get(str(navn).strip().casefold())

    mangler = [f"{felt} (\"{kolonner[felt]}\")" for felt in PAAKRAEVEDE if find(kolonner[felt]) is None]
    if mangler:
        raise InputFejl(
            "Påkrævede kolonner mangler i filen: " + ", ".join(mangler) + ".\n"
            "Kolonner fundet i filen: " + (", ".join(map(str, raa.columns)) or "(ingen)") + ".\n"
            "Ret mappingen i config/kolonner.json."
        )

    advarsler = []
    valgfrie = {}
    for felt in VALGFRIE:
        navn = kolonner.get(felt)
        valgfrie[felt] = find(navn) if navn else None
        if navn and valgfrie[felt] is None:
            advarsler.append(f"Kolonnen \"{navn}\" ({felt}) findes ikke i filen, så den bruges ikke.")

    sprunget = Counter()
    raekker = []
    d_k, s_k, a_k = (find(kolonner[f]) for f in PAAKRAEVEDE)
    for r in raa.to_dict("records"):
        if all(er_tom(v) for v in r.values()):
            continue
        if er_tom(r[s_k]):
            sprunget["uden SKU (fragt, rabat)"] += 1
            continue
        antal = parse_tal(r[a_k])
        if antal is None:
            sprunget["ugyldigt antal"] += 1
            continue
        if antal < 0:
            sprunget["negativt antal (kreditnota, retur)"] += 1
            continue
        if antal == 0:
            sprunget["antal er 0"] += 1
            continue
        dato = parse_dato(r[d_k])
        if dato is None:
            sprunget["ugyldig dato"] += 1
            continue
        tekst = lambda k: str(r[k]).strip() if k and not er_tom(r[k]) else None
        raekker.append({"dato": dato, "sku": str(r[s_k]).strip(), "antal": antal,
                        "kanal": tekst(valgfrie["kanal"]), "ordre_id": tekst(valgfrie["ordre_id"])})

    linjer = pd.DataFrame(raekker, columns=["dato", "sku", "antal", "kanal", "ordre_id"])
    linjer["dato"] = pd.to_datetime(linjer["dato"])
    linjer["antal"] = linjer["antal"].astype(float)
    return linjer, sprunget, advarsler


class fil_kilde:
    """Ordrelinjer fra en eksporteret CSV- eller XLSX-fil."""

    def __init__(self, sti, kolonner):
        self.linjer, self.sprunget, self.advarsler = normaliser(laes_fil(sti), kolonner)

    def hent_ordrelinjer(self, fra_dato=None, til_dato=None):
        """Returnerer linjer mellem datoerne (begge inklusive). None betyder ingen grænse."""
        l = self.linjer
        if fra_dato is not None:
            l = l[l["dato"] >= pd.Timestamp(fra_dato)]
        if til_dato is not None:
            l = l[l["dato"] <= pd.Timestamp(til_dato)]
        return l.copy()


class rackbeat_kilde:
    """Tom stub til Rackbeat-API'en. Ikke bygget endnu.

    UVERIFICERET: endpoints, feltnavne og godkendelse er ikke slået op. De skal
    findes på developer.rackbeat.com og må ikke gættes.
    Beregningen skal kende produktets første salg, så stubben skal også kunne hente
    historik fra før vinduet (fra_dato=None).
    """

    API_NOEGLE_VARIABEL = "RACKBEAT_API_KEY"  # Nøglen læses kun fra miljøet, aldrig fra kode eller commit
    ENDPOINT_ORDRER = None  # UVERIFICERET: se developer.rackbeat.com

    def __init__(self):
        self.api_noegle = os.environ.get(self.API_NOEGLE_VARIABEL)
        self.sprunget = Counter()
        self.advarsler = []

    def hent_ordrelinjer(self, fra_dato=None, til_dato=None):
        raise NotImplementedError(
            "Rackbeat-kilden er ikke bygget endnu. Brug en eksporteret fil (--fil)."
        )
