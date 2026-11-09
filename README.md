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
| `api/` | Vercel-funktioner til Rackbeat live (`/api/status`, `/api/salgstempo`, kun GET) |
| `functions/_lib/` | Delt kode til funktionerne (Rackbeat-klient, beregning, cache) |
| `assets/` | Kystnær-logo (sort PNG) |
| `docs/` | Skærmbilleder og noter |
| `report/` | Indholdsfortegnelse (PPTX/PDF) |
| `tests/` | Røgtest og skærmbilleder (Playwright) |

## Status
- Eksempeldata og estimeret salgstempo pr. produkt (iteration 1 og 2).
- Salgstempo kan hentes direkte fra Rackbeat (se nedenfor). Lager og minimum i kalenderen og fælles login er designet, men ikke bygget.

### Lager fra Rackbeat
Med nøglen i `.env` (se nedenfor):
```powershell
python scripts/hent_lager.py
```
Scriptet henter beholdningen (`GET /products`, feltet `stock_quantity`) og skriver kun de varer, der er i V2's produktliste, til `output/lager.json`. Klik *Importér lager fra Rackbeat* i V2 og vælg filen. Tallet står i kolonnen *Lager i Rackbeat* præcis som i Rackbeat, uden beregning. Lagertallene gemmes kun i browseren og kommer aldrig i git eller på den offentlige side.

### Salgstempo fra Rackbeat
Opret en API-nøgle i Rackbeat under *Firmaindstillinger > API* (adgang til ordrer er nok). Første gang kopieres `.env.example` til `.env`, og nøglen skrives efter `RACKBEAT_API_KEY=`. `.env` er i `.gitignore`, så nøglen kommer aldrig med i git. Derefter er det bare:
```powershell
python scripts/beregn_salgstempo.py --rackbeat
```
En miljøvariabel med samme navn går forud for `.env`, fx på en server.
Scriptet henter alle ordrelinjer fra `GET /orders/lines` og skriver `output/salgstempo.json`, som importeres i V2 med *Importér salgstempo*. Forskelle fra den eksporterede fil:
- Annullerede ordrer springes over.
- Rackbeat har ingen salgskanal på ordrelinjerne, så event- og b2b-ordrer fjernes kun, hvis de er store enkeltordrer (punkt 5 nedenfor).
- Antal er det bestilte antal, og datoen er ordredatoen.

### Rackbeat live
Når V2 kører på Vercel (se [docs/rackbeat-opsaetning.md](docs/rackbeat-opsaetning.md)), henter den selv data fra Rackbeat. Der er kun læseadgang. Rackbeat-nøglen ligger kun som Secret hos Vercel, og adgangen styres af Vercel Authentication.

- `GET /api/status` (hvert 20. sekund, kun mens fanen er synlig): lager pr. varenummer (`stock_quantity`) og salg de seneste 7 dage pr. varenummer og dag. Serveren gemmer svaret i 20 sekunder. Svarer Rackbeat ikke, sendes sidst gemte version markeret som forældet.
- `GET /api/salgstempo` (ved start og hvert 10. minut): salgstempo beregnet efter samme regler som `scripts/beregn_salgstempo.py` (testet mod scriptet på eksempeldata). Serveren gemmer resultatet i en time og beregner det nye i baggrunden.
- Ved fejl venter V2 gradvist længere (20, 40, 60 sekunder) og fortsætter med de data, den har. Pillen i sidefoden viser status: grøn (opdateret), gul (forældet) eller rød (fejl, mangler adgang eller login udløbet).
- Data ændres aldrig, mens en dialog er åben eller et felt har en ændring, der ikke er gemt. Opdateringen vises bagefter.
- Uden server (åbnet som fil eller med `npm start`) kører V2 som før med eksempeldata og filimport.

**Batches og reservationer ligger stadig kun i den enkelte browser.** Det, én person registrerer, kan andre ikke se. Login og fælles database er næste fase.

Antagelser, der skal afklares med ejeren:
1. **Pakket betyder registreret i Rackbeat.** Med lager fra Rackbeat tæller et batch med i forventet lager, indtil det er markeret *Pakket*. Derefter antages det at være med i Rackbeats lagertal. Et batch, der aldrig bliver markeret pakket, bliver ved med at tælle med. Med eget optalt lager gælder den gamle regel: batches, der er klar efter optællingen.
2. **Lager er `stock_quantity`** (beholdningen), ikke disponibelt lager. Åbne ordrer trækkes kun fra via reservationerne i kalenderen.
3. **Rackbeat vinder.** Lager og salgstempo overskrives ved næste opdatering, også hvis de er rettet i hånden.
4. **Historik til salgstempo:** serveren henter de 52 uger plus 26 uger før, for at kunne se, om et produkt er nyt (`kort_historik`). Scriptet bruger al historik. Et produkt, der ikke er solgt i de 26 uger før vinduet, kan derfor fejlagtigt få flaget.
5. **Dansk tid:** dagens dato og ugerne regnes i dansk tid. Ordredatoen bruges uden klokkeslæt.

Kendte begrænsninger:
- **Adgangen styres kun af Vercel.** Funktionerne tjekker ikke selv, hvem der kalder. Er *Vercel Authentication* ikke slået til på niveauet *All Deployments*, er `/api` åben for alle på nettet. Kontrollér det med `curl` efter hver ændring af indstillingerne (se vejledningen).
- **Hobby-planen** er gratis, men kun til ikke-kommerciel, personlig brug, og kun én ekstern bruger kan få adgang udover ejeren. Drift hos Kystnær og flere brugere kræver Pro.
- Rackbeat har ingen salgskanal på ordrelinjerne. Event- og b2b-ordrer fjernes kun, hvis de er over 3 × medianen.
- Cachen ligger i den enkelte serverinstans. Flere samtidige instanser giver hver deres kald til Rackbeat (grænse: 480 kald i minuttet). Salgstempo bruger ét kald pr. 100 ordrelinjer og stopper med fejl ved over 200 sider (ca. 20.000 linjer), frem for at regne på en halv historik.
- Om nøglen må læse lager (`GET /products`) afhænger af nøglens rettigheder. Rackbeats dokumentation nævner ingen rettighed til produkter. Uden adgang viser V2 rød pille og bruger estimeret lager.
- Kopien på GitHub Pages har ingen server og viser kun eksempeldata.

Test uden nøgle: `node --test "tests/*.test.mjs"` (server og paritet med Python) og `node tests/live_v2.js` (V2 i browser). Lokal server med mock af Rackbeat: `node tests/mock_rackbeat.js` og `node tests/dev_server.mjs`.

### Salgstempo: hvad beregningen bygger på
Scriptet `scripts/beregn_salgstempo.py` beregner et gennemsnitligt ugentligt salg pr. produkt (`rate`), som kalenderen bruger til at forudsige lagerets udvikling. Tallet er et estimat og bygger på disse antagelser:

1. **Salg er et mål for efterspørgsel.** Uger, hvor produktet var udsolgt, viser lavere salg end efterspørgslen, så tempoet kan være for lavt. Sådanne produkter flages `muligt_udsolgt`, hvis deres salg er højt nok til, at nuluger siger noget (se punkt 12).
2. **Fortiden forudsiger fremtiden.** Tempoet antager, at salget fremover ligner det seneste år. Vækst, tilbagegang, nye kanaler og kampagner indgår ikke.
3. **Vindue på 52 hele uger** (mandag–søndag). Uger uden salg tæller som 0. Et produkt, der er lanceret inden for året, beregnes kun fra første salg og flages `kort_historik`.
4. **Ét års data giver én observation pr. måned.** Det månedlige tempo (`maanedlig`) er derfor usikkert, og en enkelt usædvanlig uge kan slå stærkt igennem. Kalenderen bruger i første omgang kun årsgennemsnittet, som kan undervurdere højsæson og overvurdere lavsæson. Et månedstal beregnes kun, hvis produktet har salg i måneden og mindst 3 hele uger (mandag–søndag) med data i den, ellers er det `null`. Grænsen på 3 uger er et skøn, der skal valideres med ejeren. `maanedlig` kan altså indeholde `null`, og det skal V2 håndtere, når månedstallene tages i brug.
5. **Engangsordrer er ikke løbende salg.** Ordrer fra kanalerne event og b2b (hvis kanalen findes i eksporten) og enkeltordrer over 3 × produktets mediane ugesalg udelades af tempoet og rapporteres separat. De oprettes ikke automatisk som reservationer i kalenderen. Når produktets mediane ugesalg er 0, bruges medianen af uger med salg som grundlag for grænsen. Grænsen på 3 × er et skøn og bør justeres sammen med ejeren.
6. **Returvarer og kreditnotaer ignoreres.** Linjer med negativt antal trækkes ikke fra. Hvis returneringer er væsentlige, vil tempoet være for højt.
7. **Datoen i eksporten er ordredatoen.** Hvis eksporten bruger faktura- eller afsendelsesdato, forskydes ugerne en smule.
8. **SKU er nøglen.** Produkter, der er omdøbt, har skiftet varenummer eller er udfaset, kan ikke sammenlignes på tværs af perioden.
9. **Alle salgskanaler lægges sammen.** Der skelnes ikke mellem webshop, forhandlere og markeder, medmindre eksporten indeholder kanal.
10. **Enhed er styk pr. uge**, regnet på færdigvaren (en bar), ikke på batchstørrelse.
11. **Sikkerhed** er høj, middel eller lav. Grænser: høj = mindst 40 uger med salg og variationskoefficient under 0,6; lav = under 12 uger med salg eller variationskoefficient over 1,2; ellers middel. Grænserne er skønnede og bør valideres.
12. **Flag om udsolgt og lavt salg.** `muligt_udsolgt` sættes kun, hvis medianen af produktets uger med salg er mindst 3, og der er mindst 2 nuluger i træk efter en periode med salg. Produkter med en median under 3 får i stedet `lavt_salg`, uanset om de har nuluger, fordi nuluger er normale ved så lavt salg. Engangsordrer indgår ikke i medianen. Tærsklerne (median 3 og 2 nuluger) er skøn, der skal valideres med ejeren.

## Git-arbejdsgang
- `main` er altid fungerende. Nye ændringer sker i grene: `feature/<navn>`, merges via pull request.
- Commit-beskeder på dansk, korte og i nutid ("Tilføj sæbespåner-opgave").
- Tags markerer afleveringer: `iteration-1`, `iteration-2`, `iteration-3`.
