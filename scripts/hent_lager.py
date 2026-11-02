"""Henter lagerbeholdningen fra Rackbeat for produkterne i V2 til import i V2.

Kørsel: python scripts/hent_lager.py (nøglen læses fra .env eller RACKBEAT_API_KEY)
Filen output/lager.json importeres i V2 med "Importér lager fra Rackbeat".
Kun varenumre fra V2's produktliste kommer med i filen. Tallene er beholdningen
(stock_quantity) præcis som i Rackbeat, uden beregning.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from beregn_salgstempo import laes_v2_produkter
from ordrekilder import InputFejl, rackbeat_kilde

ROD = Path(__file__).resolve().parent.parent


def skriv_lager(lager, sti, hentet):
    data = {"kilde": "rackbeat", "hentet": hentet.strftime("%Y-%m-%dT%H:%M"), "lager": lager}
    Path(sti).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv=None, kilde=None):
    p = argparse.ArgumentParser(description="Henter lagerbeholdningen fra Rackbeat for produkterne i V2.")
    p.add_argument("--v2", default=ROD / "src" / "v2" / "produktionskalender-v2.html", help="V2's HTML-fil")
    p.add_argument("--ud", default=ROD / "output", help="mappe til output")
    a = p.parse_args(argv)
    try:
        produkter = laes_v2_produkter(a.v2)
        alle = (kilde or rackbeat_kilde()).hent_lager()
    except InputFejl as e:
        print(f"FEJL: {e}", file=sys.stderr)
        return 2
    lager = {sku: alle[sku] for sku in produkter if sku in alle}
    mangler = [sku for sku in produkter if sku not in alle]
    ud = Path(a.ud)
    ud.mkdir(parents=True, exist_ok=True)
    skriv_lager(lager, ud / "lager.json", datetime.now())
    print(f"Lager for {len(lager)} af {len(produkter)} produkter i V2:")
    for sku, antal in lager.items():
        print(f"  {sku:<8} {produkter[sku]['navn']:<26} {antal:>5}")
    if mangler:
        print(f"Ikke fundet i Rackbeat: {', '.join(mangler)}")
    print(f"Skrevet: {ud / 'lager.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
