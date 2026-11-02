"""Genererer opdigtede ordrelinjer til test. Tallene er ikke Kystnærs rigtige salg.

Kørsel: python scripts/lav_eksempeldata.py [--ud data/eksempel_ordrehistorik.csv]
Indeholder nul-uger, julestigning, store engangsordrer, en periode med udsolgt,
et nyt produkt, kreditnotaer, fragtlinjer og en SKU, som V2 ikke kender.
"""
import argparse
import math
import random
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from beregn_salgstempo import vindue

ROD = Path(__file__).resolve().parent.parent

# Opdigtet grundsalg pr. uge
GRUNDSALG = {
    "KN-1001": 17, "KN-1002": 15, "KN-1003": 13, "KN-1004": 8, "KN-1005": 11, "KN-1006": 0.6,
    "KN-2001": 19, "KN-2002": 12, "KN-2003": 6, "KN-2004": 10, "KN-2005": 13, "KN-2006": 8,
    "KN-3001": 7, "KN-3002": 6, "KN-3003": 4, "KN-3004": 9, "KN-3005": 6, "KN-4001": 2,
}
SAESON = {1: 0.8, 2: 0.85, 3: 0.9, 4: 0.95, 5: 1, 6: 0.9, 7: 0.7, 8: 0.85, 9: 1, 10: 1.1, 11: 1.6, 12: 2}
UDSOLGT_SKU, UDSOLGT_UGER = "KN-2002", range(30, 35)  # Ugenumre i vinduet uden salg
NYT_PRODUKT, NYT_FRA_UGE = "KN-3005", 34


def poisson(rng, middel):
    """Standardbiblioteket har ingen Poisson-fordeling. Knuths metode rækker her."""
    graense, k, p = math.exp(-middel), 0, 1.0
    while True:
        p *= rng.random()
        if p <= graense:
            return k
        k += 1


def lav_linjer(koerselsdato, uger=52, seed=1):
    rng = random.Random(seed)
    start, _ = vindue(koerselsdato, uger)
    linjer = []
    ordrenr = [100000]

    def tilfoej(dag, sku, antal, kanal):
        ordrenr[0] += 1
        linjer.append({"Ordredato": dag.strftime("%d-%m-%Y"), "Varenr.": sku, "Antal": antal,
                       "Kanal": kanal, "Ordrenr.": ordrenr[0]})

    for uge in range(uger):
        mandag = start + timedelta(days=7 * uge)
        for sku, grund in GRUNDSALG.items():
            if (sku == UDSOLGT_SKU and uge in UDSOLGT_UGER) or (sku == NYT_PRODUKT and uge < NYT_FRA_UGE):
                continue
            rest = poisson(rng, grund * SAESON[mandag.month])
            while rest > 0:
                antal = min(rest, rng.randint(1, max(1, min(4, math.ceil(grund / 2)))))
                dag = mandag + timedelta(days=rng.randrange(7))
                tilfoej(dag, sku, antal, rng.choice(("webshop", "webshop", "webshop", "forhandler")))
                rest -= antal

    # Store engangsordrer. Dansani-ordren fanges kun via kanalen: 40 er under 3 × hybens medianuge.
    tilfoej(start + timedelta(days=7 * 20 + 1), "KN-1002", 40, "b2b")  # Dansani
    tilfoej(start + timedelta(days=7 * 3 + 2), "KN-1001", 30, "event")  # Julemarked
    tilfoej(start + timedelta(days=7 * 40 + 3), "KN-1001", 150, "webshop")  # Kun over grænsen

    # Linjer, som scriptet skal springe over
    for i in range(8):
        dag = start + timedelta(days=30 * i + 5)
        tilfoej(dag, rng.choice(list(GRUNDSALG)), -rng.randint(1, 3), "webshop")
        tilfoej(dag, "", 1, "webshop")
    for i in range(3):
        tilfoej(start + timedelta(days=60 * i + 10), "KN-9999", 2, "webshop")

    linjer.sort(key=lambda l: (l["Ordredato"][6:], l["Ordredato"][3:5], l["Ordredato"][:2]))
    return pd.DataFrame(linjer)


def main():
    p = argparse.ArgumentParser(description="Genererer opdigtede ordrelinjer til test.")
    p.add_argument("--ud", default=ROD / "data" / "eksempel_ordrehistorik.csv", help="CSV- eller XLSX-fil")
    p.add_argument("--dato", type=date.fromisoformat, default=date.today(), help="kørselsdato (YYYY-MM-DD)")
    p.add_argument("--uger", type=int, default=52)
    a = p.parse_args()
    linjer = lav_linjer(a.dato, a.uger)
    ud = Path(a.ud)
    ud.parent.mkdir(parents=True, exist_ok=True)
    if ud.suffix.lower() == ".xlsx":
        linjer.to_excel(ud, index=False)
    else:
        linjer.to_csv(ud, index=False, sep=";", encoding="utf-8-sig")
    print(f"Skrevet: {ud} ({len(linjer)} linjer, opdigtede tal)")


if __name__ == "__main__":
    main()
