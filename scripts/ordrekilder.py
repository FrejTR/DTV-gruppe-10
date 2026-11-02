"""Ordrekilder til salgstempo-beregningen.

Alle kilder har samme interface: hent_ordrelinjer(fra_dato, til_dato) returnerer
en DataFrame med kolonnerne dato, sku, antal, kanal og ordre_id. Beregningen kender
kun det interface, så en eksporteret fil og Rackbeat-API'en kan bruges på samme måde.
"""
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
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


ENV_FIL = Path(__file__).resolve().parent.parent / ".env"


def laes_env(navn, sti=ENV_FIL):
    """Læser én værdi fra .env-filen (NAVN=værdi). Returnerer None, hvis den ikke findes."""
    sti = Path(sti)
    if not sti.exists():
        return None
    for linje in sti.read_text(encoding="utf-8-sig").splitlines():
        noegle, lig, vaerdi = linje.strip().removeprefix("export ").partition("=")
        if lig and noegle.strip() == navn:
            vaerdi = vaerdi.strip()
            if len(vaerdi) >= 2 and vaerdi[0] == vaerdi[-1] and vaerdi[0] in "\"'":
                vaerdi = vaerdi[1:-1]
            return vaerdi or None
    return None


def _hent_json(url, headers, timeout=30):
    """Henter én side fra API'en. Returnerer (statuskode, JSON)."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as svar:
            return svar.status, json.loads(svar.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None
    except urllib.error.URLError as e:
        raise InputFejl(f"Ingen forbindelse til Rackbeat: {e.reason}") from e


class rackbeat_kilde:
    """Ordrelinjer fra Rackbeat-API'en (GET /orders/lines).

    Slået op på developer.rackbeat.com (november 2026): Bearer-nøgle i Authorization,
    sider med page/limit og felterne pages og order_lines i svaret, højst 480 kald i minuttet.
    Datoen er ordredatoen (order.order_date) og antallet er det bestilte (quantities.ordered),
    som i den eksporterede fil. Annullerede ordrer springes over.
    Rackbeat-linjer har ingen salgskanal, så kanal er tom.
    """

    # Nøglen læses fra miljøet eller fra .env (som ikke er i git), aldrig fra kode eller commit.
    # Miljøvariablen går forud, så en server kan sætte den uden en .env-fil.
    API_NOEGLE_VARIABEL = "RACKBEAT_API_KEY"
    BASIS_URL = "https://app.rackbeat.com/api"
    ENDPOINT_ORDRER = "/orders/lines"
    PR_SIDE = 100
    FORSOEG_VED_429 = 5

    def __init__(self, api_noegle=None, hent=_hent_json, vent=time.sleep, env_fil=ENV_FIL):
        self.api_noegle = (api_noegle or os.environ.get(self.API_NOEGLE_VARIABEL)
                           or laes_env(self.API_NOEGLE_VARIABEL, env_fil))
        self._hent, self._vent = hent, vent
        self.sprunget = Counter()
        self.advarsler = ["Rackbeat har ingen salgskanal på ordrelinjerne. Event- og b2b-ordrer "
                          "frasorteres derfor kun, hvis de er store enkeltordrer."]

    def _side(self, params):
        url = self.BASIS_URL + self.ENDPOINT_ORDRER + "?" + urllib.parse.urlencode(params)
        headers = {"Authorization": f"Bearer {self.api_noegle}", "Accept": "application/json",
                   "Content-Type": "application/json"}
        for forsoeg in range(self.FORSOEG_VED_429 + 1):
            status, data = self._hent(url, headers)
            if status != 429:
                break
            self._vent(2 ** forsoeg)
        if status in (401, 403):
            raise InputFejl(f"Rackbeat afviste API-nøglen (HTTP {status}). Tjek {self.API_NOEGLE_VARIABEL}, "
                            "og at nøglen har adgang til ordrer.")
        if status == 429:
            raise InputFejl("Rackbeat svarer stadig 429 (for mange kald). Prøv igen om et minut.")
        if not 200 <= status < 300 or not isinstance(data, dict):
            raise InputFejl(f"Uventet svar fra Rackbeat (HTTP {status}).")
        return data

    def hent_ordrelinjer(self, fra_dato=None, til_dato=None):
        """Returnerer linjer mellem datoerne (begge inklusive). None betyder ingen grænse."""
        if not self.api_noegle:
            raise InputFejl(f"Ingen Rackbeat-nøgle fundet. Kopiér .env.example til .env, og skriv nøglen efter "
                            f"{self.API_NOEGLE_VARIABEL}=. Nøglen oprettes i Rackbeat under Firmaindstillinger > API.")
        params = {"limit": self.PR_SIDE}
        if fra_dato is not None:
            params["order_date_from"] = f"{pd.Timestamp(fra_dato):%Y-%m-%d} 00:00:00"
        if til_dato is not None:
            params["order_date_to"] = f"{pd.Timestamp(til_dato):%Y-%m-%d} 23:59:59"

        raekker, side, sider = [], 1, 1
        while side <= sider:
            data = self._side({**params, "page": side})
            sider = int(data.get("pages") or 0)
            for l in data.get("order_lines") or []:
                ordre = l.get("order") or {}
                if (ordre.get("status") or {}).get("is_cancelled"):
                    self.sprunget["annulleret ordre"] += 1
                    continue
                raekker.append({"dato": ordre.get("order_date"), "sku": (l.get("item") or {}).get("number"),
                                "antal": (l.get("quantities") or {}).get("ordered"), "kanal": None,
                                "ordre_id": ordre.get("number")})
            side += 1

        raa = pd.DataFrame(raekker, columns=["dato", "sku", "antal", "kanal", "ordre_id"], dtype=object)
        linjer, sprunget, advarsler = normaliser(raa, {f: f for f in (*PAAKRAEVEDE, *VALGFRIE)})
        self.sprunget.update(sprunget)
        self.advarsler.extend(advarsler)
        return linjer
