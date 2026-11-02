# Kystnær produktionskalender

Prototype af et planlægningslag oven på Rackbeat til Kystnær. Eksamensartefakt i *Digitale teknologier i virksomheder* (design science, tre iterationer).

**Problem:** Sæbebarer skal hærde ca. 22 dage, så batches skal startes, før lageret løber tør. Kalenderen viser forventet lager, advarer ved minimum, og gør det let at kassere et batch uden at tælle om.

## Kør lokalt
```bash
npm install
npm start        # åbner V2 på http://localhost:8080
npm test         # røgtest af begge versioner
```
Eller åbn `src/v2/produktionskalender-v2.html` direkte i browseren (ingen server nødvendig).

## Mapper
| Mappe | Indhold |
|---|---|
| `src/v1/` | Iteration 1 (frosset) |
| `src/v2/` | Aktuel version, her arbejder vi |
| `assets/` | Kystnær-logo (sort PNG) |
| `docs/` | Skærmbilleder og noter |
| `report/` | Indholdsfortegnelse (PPTX/PDF) |
| `tests/` | Røgtest og skærmbilleder (Playwright) |

## Status
- Eksempeldata og estimeret salgstempo pr. produkt (iteration 1 og 2).
- Rackbeat-integration og fælles login er designet, men ikke bygget.

## Git-arbejdsgang
- `main` er altid fungerende. Nye ændringer sker i grene: `feature/<navn>`, merges via pull request.
- Commit-beskeder på dansk, korte og i nutid ("Tilføj sæbespåner-opgave").
- Tags markerer afleveringer: `iteration-1`, `iteration-2`, `iteration-3`.
