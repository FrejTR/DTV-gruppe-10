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

### Salgstempo: hvad beregningen bygger på
Scriptet `scripts/beregn_salgstempo.py` beregner et gennemsnitligt ugentligt salg pr. produkt (`rate`), som kalenderen bruger til at forudsige lagerets udvikling. Tallet er et estimat og bygger på disse antagelser:

1. **Salg er et mål for efterspørgsel.** Uger, hvor produktet var udsolgt, viser lavere salg end efterspørgslen, så tempoet kan være for lavt. Sådanne produkter flages `muligt_udsolgt`.
2. **Fortiden forudsiger fremtiden.** Tempoet antager, at salget fremover ligner det seneste år. Vækst, tilbagegang, nye kanaler og kampagner indgår ikke.
3. **Vindue på 52 hele uger** (mandag–søndag). Uger uden salg tæller som 0. Et produkt, der er lanceret inden for året, beregnes kun fra første salg og flages `kort_historik`.
4. **Ét års data giver én observation pr. måned.** Det månedlige tempo (`maanedlig`) er derfor usikkert, og en enkelt usædvanlig uge kan slå stærkt igennem. Kalenderen bruger i første omgang kun årsgennemsnittet, som kan undervurdere højsæson og overvurdere lavsæson.
5. **Engangsordrer er ikke løbende salg.** Ordrer fra kanalerne event og b2b (hvis kanalen findes i eksporten) og enkeltordrer over 3 × produktets mediane ugesalg udelades af tempoet og rapporteres separat. De oprettes ikke automatisk som reservationer i kalenderen. Grænsen på 3 × er et skøn og bør justeres sammen med ejeren.
6. **Returvarer og kreditnotaer ignoreres.** Linjer med negativt antal trækkes ikke fra. Hvis returneringer er væsentlige, vil tempoet være for højt.
7. **Datoen i eksporten er ordredatoen.** Hvis eksporten bruger faktura- eller afsendelsesdato, forskydes ugerne en smule.
8. **SKU er nøglen.** Produkter, der er omdøbt, har skiftet varenummer eller er udfaset, kan ikke sammenlignes på tværs af perioden.
9. **Alle salgskanaler lægges sammen.** Der skelnes ikke mellem webshop, forhandlere og markeder, medmindre eksporten indeholder kanal.
10. **Enhed er styk pr. uge**, regnet på færdigvaren (en bar), ikke på batchstørrelse.
11. **Sikkerhed** er høj, middel eller lav. Grænser: høj = mindst 40 uger med salg og variationskoefficient under 0,6; lav = under 12 uger med salg eller variationskoefficient over 1,2; ellers middel. Grænserne er skønnede og bør valideres.

## Git-arbejdsgang
- `main` er altid fungerende. Nye ændringer sker i grene: `feature/<navn>`, merges via pull request.
- Commit-beskeder på dansk, korte og i nutid ("Tilføj sæbespåner-opgave").
- Tags markerer afleveringer: `iteration-1`, `iteration-2`, `iteration-3`.
