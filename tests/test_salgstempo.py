"""Test af salgstempo-beregningen. Kørsel: python -m pytest tests/"""
import json
import re
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

import beregn_salgstempo as bs
import lav_eksempeldata
import ordrekilder as ok

ROD = Path(__file__).resolve().parent.parent
V2 = ROD / "src" / "v2" / "produktionskalender-v2.html"
KOLONNER = {"dato": "Ordredato", "sku": "Varenr.", "antal": "Antal", "kanal": None, "ordre_id": "Ordrenr."}
# 2. november 2026 er en mandag, så vinduet slutter søndag 1. november
KOERSEL = date(2026, 11, 2)
START, SLUT = bs.vindue(KOERSEL, 52)


def lav(*raekker):
    """Bygger ordrelinjer ud fra (dato, sku, antal[, kanal[, ordre_id]])."""
    data = [{"dato": pd.Timestamp(r[0]), "sku": r[1], "antal": float(r[2]),
             "kanal": r[3] if len(r) > 3 else None, "ordre_id": r[4] if len(r) > 4 else None} for r in raekker]
    return pd.DataFrame(data, columns=["dato", "sku", "antal", "kanal", "ordre_id"])


def hver_uge(sku="A", antal=10, uger=52, fra=START):
    return [(fra + timedelta(days=7 * i), sku, antal) for i in range(uger)]


def resultat(linjer, sku="A"):
    return bs.beregn_alle(linjer, KOERSEL, 52)[sku]


def skriv_csv(tmp_path, tekst, kodning="utf-8"):
    sti = tmp_path / "ordrer.csv"
    sti.write_bytes(tekst.encode(kodning))
    return sti


# ---------- vindue og ugeaggregering ----------

def test_vindue_er_52_hele_uger_mandag_til_soendag():
    assert START == date(2025, 11, 3) and START.weekday() == 0
    assert SLUT == date(2026, 11, 1) and SLUT.weekday() == 6
    assert (SLUT - START).days + 1 == 52 * 7


@pytest.mark.parametrize("dato,forventet", [
    (date(2026, 11, 2), date(2026, 11, 1)),   # mandag: gårsdagen afslutter ugen
    (date(2026, 11, 8), date(2026, 11, 1)),   # søndag: ugen er ikke slut endnu
    (date(2026, 11, 9), date(2026, 11, 8)),
])
def test_vindue_medtager_ikke_den_igangvaerende_uge(dato, forventet):
    assert bs.vindue(dato, 52)[1] == forventet


def test_salg_uden_for_vinduet_taeller_ikke_med():
    linjer = lav(*hver_uge(), (START - timedelta(days=1), "A", 999), (SLUT + timedelta(days=1), "A", 999))
    assert resultat(linjer)["rate"] == 10


def test_ugeaggregering_giver_nul_uger():
    uger = bs.ugesalg(lav(("2026-01-05", "A", 3), ("2026-01-11", "A", 2), ("2026-01-19", "A", 7)),
                      pd.Timestamp("2026-01-05"), pd.Timestamp("2026-01-25"))
    assert uger.tolist() == [5, 0, 7]


def test_nul_uger_saenker_raten():
    linjer = lav(*[(START + timedelta(days=14 * i), "A", 10) for i in range(26)])
    assert resultat(linjer)["rate"] == 5


def test_uger_parameter():
    assert bs.beregn_alle(lav(*hver_uge()), KOERSEL, 4)["A"]["vindue_uger"] == 4
    assert bs.beregn_alle(lav(*hver_uge(antal=10)), KOERSEL, 4)["A"]["rate"] == 10


def test_seneste8_bruger_kun_de_sidste_otte_uger():
    linjer = lav(*hver_uge(antal=10, uger=44), *hver_uge(antal=20, uger=8, fra=START + timedelta(days=7 * 44)))
    assert resultat(linjer)["seneste8"] == 20


# ---------- kort historik og sæson ----------

def test_nyt_produkt_regnes_fra_foerste_salg_og_flages():
    fra = SLUT - timedelta(days=7 * 10 - 1)
    r = resultat(lav(*hver_uge(uger=10, fra=fra)))
    assert r["rate"] == 10 and r["uger_i_beregning"] == 10
    assert "kort_historik" in r["flag"]


def test_produkt_med_salg_foer_vinduet_faar_ikke_kort_historik():
    r = resultat(lav((START - timedelta(days=100), "A", 5), *hver_uge(uger=26)))
    assert "kort_historik" not in r["flag"]
    assert r["uger_i_beregning"] == 52 and r["rate"] == 5


def test_seneste8_ved_under_otte_ugers_historik():
    fra = SLUT - timedelta(days=7 * 4 - 1)
    assert resultat(lav(*hver_uge(uger=4, fra=fra)))["seneste8"] == 10


def test_maanedlig_fordeling_ved_jaevnt_salg():
    r = resultat(lav(*hver_uge()))
    assert len(r["maanedlig"]) == 12
    assert all(v == pytest.approx(10, abs=2.5) for v in r["maanedlig"])
    assert "ufuldstaendig_saeson" not in r["flag"]


def test_maanedlig_regner_pr_dag_i_maaneden():
    # 62 stk. 1. til 31. januar 2026: 2 stk. om dagen er 14 stk. om ugen
    linjer = lav(*[(date(2026, 1, 1) + timedelta(days=i), "A", 2) for i in range(31)])
    assert resultat(linjer)["maanedlig"][0] == 14


def test_ufuldstaendig_saeson_beregner_kun_solgte_maaneder():
    r = resultat(lav(*[(date(2026, 3, 2) + timedelta(days=7 * i), "A", 7) for i in range(8)]))
    solgte = [i for i, v in enumerate(r["maanedlig"]) if v is not None]
    assert solgte == [2, 3]  # marts og april
    assert "ufuldstaendig_saeson" in r["flag"]


@pytest.mark.parametrize("foerste_salg,har_tal", [(date(2026, 10, 5), True), (date(2026, 10, 12), False)])
def test_maanedstal_kraever_tre_hele_uger(foerste_salg, har_tal):
    # Oktober 2026 har tre hele uger: 5.-11., 12.-18. og 19.-25.
    uger = (SLUT - foerste_salg).days // 7 + 1
    oktober = resultat(lav(*hver_uge(uger=uger, fra=foerste_salg)))["maanedlig"][9]
    assert (oktober is not None) == har_tal


def test_hele_aaret_har_tal_i_alle_maaneder():
    assert None not in resultat(lav(*hver_uge()))["maanedlig"]


def test_kn_3005_faar_null_i_november_trods_salg(tmp_path):
    sti = tmp_path / "eksempel.csv"
    lav_eksempeldata.lav_linjer(KOERSEL).to_csv(sti, index=False, sep=";")
    linjer = ok.fil_kilde(sti, {**KOLONNER, "kanal": "Kanal"}).hent_ordrelinjer()
    november = linjer[(linjer["sku"] == "KN-3005") & (linjer["dato"].dt.month == 11)]
    assert november["antal"].sum() > 0  # Der er salg, men kun på én dag af vinduet
    r = resultat(linjer, "KN-3005")
    assert r["maanedlig"][10] is None
    assert r["maanedlig"][5] is None  # Juni: kun to dage efter første salg
    assert r["maanedlig"][9] is not None
    assert "ufuldstaendig_saeson" in r["flag"]


# ---------- engangsordrer ----------

def test_stor_enkeltordre_fjernes_og_rapporteres():
    r = resultat(lav(*hver_uge(), (START + timedelta(days=7), "A", 31)))
    assert r["rate"] == 10
    assert r["engangsordrer_antal"] == 1 and r["engangsordrer_stk"] == 31


def test_ordre_paa_praecis_tre_gange_median_beholdes():
    r = resultat(lav(*hver_uge(), (START + timedelta(days=7), "A", 30)))
    assert r["engangsordrer_antal"] == 0


def test_linjer_i_samme_ordre_laegges_sammen():
    r = resultat(lav(*hver_uge(), (START + timedelta(days=7), "A", 20, None, "O1"),
                     (START + timedelta(days=7), "A", 20, None, "O1")))
    assert r["engangsordrer_antal"] == 1 and r["engangsordrer_stk"] == 40


def test_kanal_event_og_b2b_fjernes_uanset_stoerrelse():
    r = resultat(lav(*hver_uge(), (START, "A", 2, "Event", "E1"), (START, "A", 3, "b2b", "B1")))
    assert r["rate"] == 10
    assert r["engangsordrer_antal"] == 2 and r["engangsordrer_stk"] == 5


def test_sjaeldent_solgt_vare_mister_ikke_alle_ordrer_ved_median_nul():
    linjer = lav(*[(START + timedelta(days=28 * i), "A", 2) for i in range(13)])
    r = resultat(linjer)
    assert r["engangsordrer_antal"] == 0
    assert r["rate"] == 0.5


def test_kun_engangsordrer_kommer_ikke_i_json(tmp_path):
    produkter = {"A": {"navn": "A", "rate": 5.0}}
    res = bs.saml_resultater(lav((START, "A", 5, "b2b")), produkter, KOERSEL, 52)
    assert "kun_engangsordrer" in res["A"]["flag"]
    bs.skriv_json(res, tmp_path / "ud.json")
    assert json.loads((tmp_path / "ud.json").read_text(encoding="utf-8")) == {}


# ---------- udsolgt og sikkerhed ----------

def med_pause(antal, uger=52, pause=(20, 21)):
    return [u for i, u in enumerate(hver_uge(antal=antal, uger=uger)) if i not in pause]


def test_muligt_udsolgt_ved_median_paa_taerskel_og_to_nuluger():
    flag = resultat(lav(*med_pause(3)))["flag"]
    assert "muligt_udsolgt" in flag and "lavt_salg" not in flag


def test_lavt_salg_i_stedet_for_muligt_udsolgt():
    flag = resultat(lav(*med_pause(2)))["flag"]
    assert "lavt_salg" in flag and "muligt_udsolgt" not in flag


def test_lavt_salg_kraever_ikke_nuluger():
    assert "lavt_salg" in resultat(lav(*hver_uge(antal=2)))["flag"]


def test_en_nuluge_giver_ikke_muligt_udsolgt():
    flag = resultat(lav(*med_pause(3, pause=(20,))))["flag"]
    assert "muligt_udsolgt" not in flag and "lavt_salg" not in flag


def test_engangsordrer_taeller_ikke_med_i_median_for_lavt_salg():
    uger = [(d, s, a, "b2b", f"B{i}") for i, (d, s, a) in enumerate(hver_uge(antal=9, uger=10))]
    assert "lavt_salg" in resultat(lav(*uger, *hver_uge(antal=2)))["flag"]


def test_muligt_udsolgt():
    assert bs.muligt_udsolgt([5, 5, 0, 0, 5], False)
    assert not bs.muligt_udsolgt([5, 0, 5, 0, 5], False)
    assert not bs.muligt_udsolgt([0, 0, 5, 5], False)
    assert bs.muligt_udsolgt([0, 0, 5, 5], True)


def test_uge_med_kun_engangsordre_taeller_ikke_som_udsolgt():
    uger = [u for i, u in enumerate(hver_uge()) if i not in (10, 11)]
    r = resultat(lav(*uger, (START + timedelta(days=7 * 10), "A", 5, "b2b")))
    assert "muligt_udsolgt" not in r["flag"]


@pytest.mark.parametrize("uger,variation,forventet", [
    (40, 0.59, "høj"), (39, 0.1, "middel"), (40, 0.6, "middel"),
    (12, 1.2, "middel"), (11, 0.1, "lav"), (52, 1.21, "lav"), (0, None, "lav"),
])
def test_sikkerhed_graenser(uger, variation, forventet):
    assert bs.sikkerhed(uger, variation) == forventet


# ---------- indlæsning ----------

def test_danske_tal_og_datoer(tmp_path):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal;Ordrenr.\n05-01-2026;KN-1;2,5;1\n2026-01-06;KN-2;1.234;2\n")
    linjer = ok.fil_kilde(sti, KOLONNER).hent_ordrelinjer()
    assert linjer["antal"].tolist() == [2.5, 1234]
    assert linjer["dato"].tolist() == [pd.Timestamp("2026-01-05"), pd.Timestamp("2026-01-06")]


@pytest.mark.parametrize("tekst,tal", [
    ("3", 3), ("2,5", 2.5), ("1.234,5", 1234.5), ("1,234.5", 1234.5), ("12.5", 12.5),
    ("-3", -3), ("−3", -3), ("3-", -3), ("(3)", -3), ("1 000", 1000), (7, 7), ("abc", None), ("", None),
])
def test_parse_tal(tekst, tal):
    assert ok.parse_tal(tekst) == tal


@pytest.mark.parametrize("tekst", ["05-01-2026", "2026-01-05", "05/01/2026", "05.01.2026", "05-01-2026 13:45"])
def test_parse_dato_er_dag_foerst(tekst):
    assert ok.parse_dato(tekst) == pd.Timestamp("2026-01-05")


def test_komma_som_skilletegn(tmp_path):
    sti = skriv_csv(tmp_path, 'Ordredato,Varenr.,Antal\n05-01-2026,KN-1,"2,5"\n')
    assert ok.fil_kilde(sti, KOLONNER).hent_ordrelinjer()["antal"].tolist() == [2.5]


def test_windows_1252_kodning(tmp_path):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal;Bemærkning\n05-01-2026;KN-1;2;Sæbe\n", "cp1252")
    assert len(ok.fil_kilde(sti, KOLONNER).hent_ordrelinjer()) == 1


def test_xlsx_med_excel_datoer(tmp_path):
    sti = tmp_path / "ordrer.xlsx"
    pd.DataFrame({"Ordredato": [pd.Timestamp("2026-01-05"), "06-01-2026"], "Varenr.": ["KN-1", "KN-2"],
                  "Antal": [3, "1,5"]}).to_excel(sti, index=False)
    linjer = ok.fil_kilde(sti, KOLONNER).hent_ordrelinjer()
    assert linjer["antal"].tolist() == [3, 1.5]
    assert linjer["dato"].tolist() == [pd.Timestamp("2026-01-05"), pd.Timestamp("2026-01-06")]


def test_manglende_kolonne_giver_fejl_med_fundne_kolonner(tmp_path):
    sti = skriv_csv(tmp_path, "Dato;Varenr.;Antal\n05-01-2026;KN-1;2\n")
    with pytest.raises(ok.InputFejl) as e:
        ok.fil_kilde(sti, KOLONNER)
    assert "Ordredato" in str(e.value) and "Dato, Varenr., Antal" in str(e.value)


def test_manglende_valgfri_kolonne_giver_kun_advarsel(tmp_path):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal\n05-01-2026;KN-1;2\n")
    kilde = ok.fil_kilde(sti, {**KOLONNER, "kanal": "Kanal"})
    assert len(kilde.hent_ordrelinjer()) == 1
    assert any("Kanal" in a for a in kilde.advarsler)


def test_negative_antal_og_manglende_sku_springes_over_og_taelles(tmp_path):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal\n05-01-2026;KN-1;2\n05-01-2026;KN-1;-1\n"
                              "05-01-2026;;1\n05-01-2026;KN-1;x\n99-99-2026;KN-1;1\n;;\n")
    kilde = ok.fil_kilde(sti, KOLONNER)
    assert len(kilde.hent_ordrelinjer()) == 1
    assert kilde.sprunget["negativt antal (kreditnota, retur)"] == 1
    assert kilde.sprunget["uden SKU (fragt, rabat)"] == 1
    assert kilde.sprunget["ugyldigt antal"] == 1
    assert kilde.sprunget["ugyldig dato"] == 1
    assert sum(kilde.sprunget.values()) == 4  # Helt tomme rækker tælles ikke


def test_helt_tom_fil_giver_tydelig_fejl(tmp_path):
    with pytest.raises(ok.InputFejl, match="tom"):
        ok.fil_kilde(skriv_csv(tmp_path, ""), KOLONNER)


def test_kilde_filtrerer_paa_datoer(tmp_path):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal\n05-01-2026;A;1\n06-01-2026;A;1\n07-01-2026;A;1\n")
    assert len(ok.fil_kilde(sti, KOLONNER).hent_ordrelinjer(date(2026, 1, 6), date(2026, 1, 6))) == 1


# ---------- Rackbeat ----------

def rb_linje(sku, antal, dato="2026-01-05", ordre=1, annulleret=False):
    return {"item": {"number": sku} if sku else None, "quantities": {"ordered": antal, "shipped": 0},
            "order": {"number": ordre, "order_date": dato, "status": {"is_cancelled": annulleret}}}


def falsk_rackbeat(*sider, status=206):
    """Svarer med én side ad gangen og gemmer de kaldte URL'er."""
    kald = []

    def hent(url, headers):
        kald.append((url, headers))
        side = int(re.search(r"page=(\d+)", url).group(1))
        return status, {"order_lines": sider[side - 1], "pages": len(sider), "page": side}
    return hent, kald


def test_rackbeat_noegle_laeses_fra_miljoeet(monkeypatch):
    monkeypatch.setenv("RACKBEAT_API_KEY", "test")
    assert ok.rackbeat_kilde().api_noegle == "test"


def test_rackbeat_uden_noegle_giver_tydelig_fejl(monkeypatch, tmp_path):
    monkeypatch.delenv("RACKBEAT_API_KEY", raising=False)
    with pytest.raises(ok.InputFejl, match="RACKBEAT_API_KEY"):
        ok.rackbeat_kilde(env_fil=tmp_path / "findes-ikke").hent_ordrelinjer()


def test_rackbeat_noegle_laeses_fra_env_fil(monkeypatch, tmp_path):
    monkeypatch.delenv("RACKBEAT_API_KEY", raising=False)
    env = tmp_path / ".env"
    env.write_text("# kommentar\nANDEN=1\nRACKBEAT_API_KEY = \"fra-fil\"\n", encoding="utf-8")
    assert ok.rackbeat_kilde(env_fil=env).api_noegle == "fra-fil"


def test_miljoevariabel_gaar_forud_for_env_fil(monkeypatch, tmp_path):
    monkeypatch.setenv("RACKBEAT_API_KEY", "fra-miljoe")
    env = tmp_path / ".env"
    env.write_text("RACKBEAT_API_KEY=fra-fil\n", encoding="utf-8")
    assert ok.rackbeat_kilde(env_fil=env).api_noegle == "fra-miljoe"


def test_tom_noegle_i_env_fil_taeller_som_manglende(tmp_path):
    env = tmp_path / ".env"
    env.write_text("RACKBEAT_API_KEY=\n", encoding="utf-8")
    assert ok.laes_env("RACKBEAT_API_KEY", env) is None


def test_rackbeat_henter_alle_sider_og_normaliserer():
    hent, kald = falsk_rackbeat([rb_linje("A", 2), rb_linje("B", 1, ordre=2)], [rb_linje("A", 3, "2026-01-06")])
    linjer = ok.rackbeat_kilde("hemmelig", hent=hent).hent_ordrelinjer()
    assert len(kald) == 2
    assert kald[0][1]["Authorization"] == "Bearer hemmelig"
    assert list(linjer["sku"]) == ["A", "B", "A"]
    assert list(linjer["antal"]) == [2.0, 1.0, 3.0]
    assert list(linjer["ordre_id"]) == ["1", "2", "1"]
    assert linjer["dato"].iloc[2] == pd.Timestamp(2026, 1, 6)


def test_rackbeat_sender_datofilter():
    hent, kald = falsk_rackbeat([])
    ok.rackbeat_kilde("x", hent=hent).hent_ordrelinjer(date(2026, 1, 1), date(2026, 2, 1))
    url = kald[0][0]
    assert "order_date_from=2026-01-01+00%3A00%3A00" in url
    assert "order_date_to=2026-02-01+23%3A59%3A59" in url


def test_rackbeat_springer_annullerede_og_linjer_uden_vare_over():
    hent, _ = falsk_rackbeat([rb_linje("A", 2, annulleret=True), rb_linje(None, 1), rb_linje("A", -1), rb_linje("A", 4)])
    kilde = ok.rackbeat_kilde("x", hent=hent)
    linjer = kilde.hent_ordrelinjer()
    assert list(linjer["antal"]) == [4.0]
    assert kilde.sprunget["annulleret ordre"] == 1
    assert kilde.sprunget["uden SKU (fragt, rabat)"] == 1
    assert kilde.sprunget["negativt antal (kreditnota, retur)"] == 1


def test_rackbeat_venter_og_proever_igen_ved_429():
    svar = [(429, None), (429, None), (206, {"order_lines": [rb_linje("A", 1)], "pages": 1})]
    ventet = []
    kilde = ok.rackbeat_kilde("x", hent=lambda url, h: svar.pop(0), vent=ventet.append)
    assert len(kilde.hent_ordrelinjer()) == 1
    assert ventet == [1, 2]


@pytest.mark.parametrize("status", [401, 403])
def test_rackbeat_afvist_noegle_giver_tydelig_fejl(status):
    hent, _ = falsk_rackbeat([], status=status)
    with pytest.raises(ok.InputFejl, match="afviste API-nøglen"):
        ok.rackbeat_kilde("x", hent=hent).hent_ordrelinjer()


def test_koer_med_rackbeat_kilde(tmp_path, capsys):
    linjer = [rb_linje("KN-1001", 5, str(START + timedelta(weeks=u)), ordre=u) for u in range(52)]
    hent, _ = falsk_rackbeat(linjer)
    res = bs.koer(None, 52, _mapping(tmp_path), V2, tmp_path / "ud", KOERSEL, ok.rackbeat_kilde("x", hent=hent))
    assert res["KN-1001"]["rate"] == 5
    assert "ingen salgskanal" in capsys.readouterr().out


# ---------- output og hele kørslen ----------

def test_v2_produktliste_laeses_fra_html():
    produkter = bs.laes_v2_produkter(V2)
    assert len(produkter) == 18
    assert produkter["KN-1001"] == {"navn": "Havtorn sæbe bar", "rate": 20.0}
    assert produkter["KN-4001"]["rate"] == 6.0


def test_sku_uden_salg_rapporteres_og_kommer_ikke_i_json(tmp_path, capsys):
    sti = skriv_csv(tmp_path, f"Ordredato;Varenr.;Antal\n{(START + timedelta(days=1)).strftime('%d-%m-%Y')};KN-1001;5\n")
    res = bs.koer(sti, 52, _mapping(tmp_path), V2, tmp_path / "ud", KOERSEL)
    assert res["KN-1002"]["rate"] is None and "ingen_salg" in res["KN-1002"]["flag"]
    data = json.loads((tmp_path / "ud" / "salgstempo.json").read_text(encoding="utf-8"))
    assert "KN-1001" in data and "KN-1002" not in data
    assert "uden løbende salg" in capsys.readouterr().out


def test_sku_kun_foer_vinduet_regnes_som_uden_salg():
    assert resultat(lav((START - timedelta(days=30), "A", 5)))["flag"] == ["ingen_salg"]


def test_ukendt_sku_rapporteres(tmp_path, capsys):
    dato = (START + timedelta(days=1)).strftime("%d-%m-%Y")
    sti = skriv_csv(tmp_path, f"Ordredato;Varenr.;Antal\n{dato};KN-9999;5\n")
    bs.koer(sti, 52, _mapping(tmp_path), V2, tmp_path / "ud", KOERSEL)
    assert "ikke findes i V2: KN-9999" in capsys.readouterr().out


def test_tomt_datasaet_giver_tom_json(tmp_path, capsys):
    sti = skriv_csv(tmp_path, "Ordredato;Varenr.;Antal\n")
    bs.koer(sti, 52, _mapping(tmp_path), V2, tmp_path / "ud", KOERSEL)
    assert json.loads((tmp_path / "ud" / "salgstempo.json").read_text(encoding="utf-8")) == {}
    assert "Ingen brugbare ordrelinjer" in capsys.readouterr().out


def test_fil_der_ikke_daekker_vinduet_giver_advarsel():
    advarsler = bs.daekningsadvarsler(lav((START + timedelta(days=100), "A", 1)), START, SLUT)
    assert len(advarsler) == 2


def test_main_returnerer_2_ved_inputfejl(tmp_path, capsys):
    assert bs.main(["--fil", str(tmp_path / "findes-ikke.csv"), "--ud", str(tmp_path)]) == 2
    assert "FEJL" in capsys.readouterr().err


@pytest.mark.parametrize("tal,decimaler,tekst", [
    (0.625, 2, "0,63"), (16.625, 2, "16,63"), (1.005, 2, "1,01"), (17.288461538461537, 2, "17,29"),
    (20.0, 2, "20,00"), (-13.55, 1, "-13,6"), (None, 2, "–"),
])
def test_vis_tal_bruger_almindelig_afrunding(tal, decimaler, tekst):
    assert bs.vis_tal(tal, decimaler) == tekst


def test_json_og_csv_gemmer_fuld_praecision(tmp_path):
    linjer = lav(*[(START + timedelta(days=7 * i), "A", 3 if i % 3 else 4) for i in range(52)])
    produkter = {"A": {"navn": "A", "rate": 7.0}}
    res = bs.saml_resultater(linjer, produkter, KOERSEL, 52)
    bs.skriv_json(res, tmp_path / "ud.json")
    bs.skriv_csv(res, tmp_path / "ud.csv", produkter)

    forventet = (3 * 52 + 18) / 52
    post = json.loads((tmp_path / "ud.json").read_text(encoding="utf-8"))["A"]
    assert post["rate"] == forventet
    tabel = pd.read_csv(tmp_path / "ud.csv", sep=";", dtype=str, encoding="utf-8-sig")
    assert float(tabel.loc[0, "rate"].replace(",", ".")) == forventet
    assert float(tabel.loc[0, "afvigelse_pct"].replace(",", ".")) == (forventet - 7) / 7 * 100


def test_rapporten_afrunder_uden_at_aendre_resultatet(tmp_path, capsys):
    uger = hver_uge(antal=5, uger=44) + [(START + timedelta(days=7 * (44 + i)), "KN-1001", v)
                                        for i, v in enumerate([0, 1, 0, 0, 1, 0, 2, 1])]
    linjer = lav(*[(d, "KN-1001", a) for d, _, a in uger])
    sti = tmp_path / "ordrer.csv"
    linjer.assign(dato=linjer["dato"].dt.strftime("%d-%m-%Y")).rename(
        columns={"dato": "Ordredato", "sku": "Varenr.", "antal": "Antal"})[["Ordredato", "Varenr.", "Antal"]].to_csv(sti, index=False, sep=";")
    res = bs.koer(sti, 52, _mapping(tmp_path), V2, tmp_path / "ud", KOERSEL)
    assert res["KN-1001"]["seneste8"] == 0.625
    assert " 0,63 " in capsys.readouterr().out


def test_afvigelse():
    assert bs.afvigelse_pct(20, 25) == 25
    assert bs.afvigelse_pct(0, 25) is None
    assert bs.afvigelse_pct(20, None) is None


def test_json_format_og_csv_paa_eksempeldata(tmp_path):
    sti = tmp_path / "eksempel.csv"
    lav_eksempeldata.lav_linjer(KOERSEL).to_csv(sti, index=False, sep=";")
    bs.koer(sti, 52, _mapping(tmp_path, kanal="Kanal"), V2, tmp_path / "ud", KOERSEL)

    data = json.loads((tmp_path / "ud" / "salgstempo.json").read_text(encoding="utf-8"))
    assert set(lav_eksempeldata.GRUNDSALG) <= set(data)
    post = data["KN-1001"]
    assert {"rate", "maanedlig", "seneste8", "beregnet", "vindue_uger", "sikkerhed", "flag"} <= set(post)
    assert len(post["maanedlig"]) == 12 and post["beregnet"] == "2026-11-02" and post["vindue_uger"] == 52
    # De indbyggede situationer i eksempeldata skal kunne genfindes
    assert post["engangsordrer_stk"] >= 180
    assert data["KN-1002"]["engangsordrer_stk"] >= 40
    assert "muligt_udsolgt" in data["KN-2002"]["flag"]
    assert "lavt_salg" in data["KN-1006"]["flag"] and "muligt_udsolgt" not in data["KN-1006"]["flag"]
    assert "kort_historik" in data["KN-3005"]["flag"]

    tabel = pd.read_csv(tmp_path / "ud" / "salgstempo.csv", sep=";", dtype=str, encoding="utf-8-sig")
    assert {"estimat_nu", "beregnet", "afvigelse_pct", "beregnet_dato"} <= set(tabel.columns)
    assert len(tabel) == 19  # 18 produkter og KN-9999


def test_eksempeldata_er_reproducerbare():
    a, b = lav_eksempeldata.lav_linjer(KOERSEL), lav_eksempeldata.lav_linjer(KOERSEL)
    assert a.equals(b)


def _mapping(tmp_path, kanal=None):
    sti = tmp_path / "kolonner.json"
    sti.write_text(json.dumps({**KOLONNER, "kanal": kanal}), encoding="utf-8")
    return sti
