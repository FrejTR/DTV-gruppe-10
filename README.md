# Kystnær produktionskalender

Prototype af et planlægningslag oven på Rackbeat til Kystnær. Eksamensartefakt i *Digitale teknologier i virksomheder* (design science, tre iterationer).

**Problem:** Sæbebarer skal hærde ca. 22 dage, så batches skal startes, før lageret løber tør. Kalenderen viser forventet lager, advarer ved minimum, og gør det let at kassere et batch uden at tælle om.

## Kør lokalt
Appen henter alle data fra serveren og virker ikke, hvis HTML-filen åbnes direkte. Lokalt bruges en mock af Rackbeat, så der ikke skal bruges en rigtig nøgle:
```bash
npm install
cp .env.example .env   # udfyld: RACKBEAT_API_KEY=lokal-test og RACKBEAT_BASE_URL=http://127.0.0.1:8790
npm run mock           # mock af Rackbeat (terminal 1)
npm start              # lokal server: http://127.0.0.1:8788/v2/produktionskalender-v2.html (terminal 2)
npm test               # alle test, kræver ingen nøgle
```
Opsætning på Vercel og med rigtig nøgle: [docs/rackbeat-opsaetning.md](docs/rackbeat-opsaetning.md).

## Mapper
| Mappe | Indhold |
|---|---|
| `src/v1/` | Iteration 1 (frosset) |
| `src/v2/` | Aktuel version, her arbejder vi |
| `api/` | Vercel-funktioner til Rackbeat live (`/api/status`, `/api/salgstempo`, kun GET) |
| `functions/_lib/` | Delt kode til funktionerne (Rackbeat-klient, beregning af salgstempo, cache) |
| `assets/` | Kystnær-logo (sort PNG) |
| `docs/` | Opsætning af Vercel og Rackbeat, noter |
| `report/` | Indholdsfortegnelse (PPTX/PDF) |
| `tests/` | Test, mock af Rackbeat og lokal server. Testdata og facit i `tests/fixtures/` |

## Status
- V2 henter lager og salgstempo live fra Rackbeat (kun læsning) og kører på Vercel bag login.
- Produkterne har Rackbeats varenumre og navne og tørretiderne fra produktionsoversigten. Minimum og typisk batch er foreløbige tal, som i næste fase bliver tomme, til ejeren udfylder dem.
- Batches, reservationer og personer starter tomme. De ligger indtil videre kun i den enkelte browser. Fælles data er næste fase.

### Rackbeat live
Når V2 kører på Vercel (se [docs/rackbeat-opsaetning.md](docs/rackbeat-opsaetning.md)), henter den selv data fra Rackbeat. Der er kun læseadgang. Rackbeat-nøglen ligger kun som Secret hos Vercel, og adgangen styres af Vercel Authentication.

- `GET /api/status` (hvert 20. sekund, kun mens fanen er synlig): lager pr. varenummer (`stock_quantity`). Serveren gemmer svaret i 20 sekunder. Svarer Rackbeat ikke, sendes sidst gemte version markeret som forældet.
- `GET /api/salgstempo` (ved start og hvert 10. minut): salgstempo beregnet af serveren efter reglerne nedenfor. Beregningen er testet mod facit fra det oprindelige Python-script (`tests/fixtures/salgstempo_facit.json`). Serveren gemmer resultatet i en time og beregner det nye i baggrunden.
- Ved fejl venter V2 gradvist længere (20, 40, 60 sekunder) og fortsætter med de data, den har. Pillen i sidefoden viser status: grøn (opdateret), gul (forældet) eller rød (fejl, mangler adgang eller login udløbet).
- Data ændres aldrig, mens en dialog er åben eller et felt har en ændring, der ikke er gemt. Opdateringen vises bagefter.
- Uden server (fx åbnet direkte som fil) viser pillen "ingen forbindelse", og der er ingen data.

**Batches og reservationer ligger stadig kun i den enkelte browser.** Det, én person registrerer, kan andre ikke se. Login og fælles database er næste fase.

Antagelser, der skal afklares med ejeren:
1. **Pakket betyder registreret i Rackbeat.** Med lager fra Rackbeat tæller et batch med i forventet lager, indtil det er markeret *Pakket*. Derefter antages det at være med i Rackbeats lagertal. Et batch, der aldrig bliver markeret pakket, bliver ved med at tælle med. Et produkt uden lager fra Rackbeat (fx uden varenummer) regnes fra 0.
2. **Lager er `stock_quantity`** (beholdningen), ikke disponibelt lager. Åbne ordrer trækkes kun fra via reservationerne i kalenderen.
3. **Rackbeat vinder.** Lager og salgstempo overskrives ved næste opdatering, også hvis de er rettet i hånden.
4. **Historik til salgstempo:** serveren henter de 52 uger plus 26 uger før, for at kunne se, om et produkt er nyt (`kort_historik`). Det oprindelige Python-script brugte al historik. Et produkt, der ikke er solgt i de 26 uger før vinduet, kan derfor fejlagtigt få flaget.
5. **Dansk tid:** dagens dato og ugerne regnes i dansk tid. Ordredatoen bruges uden klokkeslæt.

Kendte begrænsninger:
- **Adgangen styres kun af Vercel.** Funktionerne tjekker ikke selv, hvem der kalder. Er *Vercel Authentication* ikke slået til på niveauet *All Deployments*, er `/api` åben for alle på nettet. Kontrollér det med `curl` efter hver ændring af indstillingerne (se vejledningen).
- **Hobby-planen** er gratis, men kun til ikke-kommerciel, personlig brug, og kun én ekstern bruger kan få adgang udover ejeren. Drift hos Kystnær og flere brugere kræver Pro.
- Rackbeat har ingen salgskanal på ordrelinjerne. Event- og b2b-ordrer fjernes kun, hvis de er over 3 × medianen.
- Cachen ligger i den enkelte serverinstans. Flere samtidige instanser giver hver deres kald til Rackbeat (grænse: 480 kald i minuttet). Salgstempo bruger ét kald pr. 100 ordrelinjer og stopper med fejl ved over 200 sider (ca. 20.000 linjer), frem for at regne på en halv historik.
- Nøglen skal kunne læse produkter (`GET /products`). Rackbeats dokumentation nævner ingen særskilt rettighed til det. Uden adgang viser V2 rød pille, og lageret står som "Ikke hentet".
- Produkter uden løbende salg i Rackbeat får intet salgstempo (0 pr. uge), så kalenderen forventer ikke, at deres lager falder.

Test uden nøgle: `npm test` (røgtest, serverfunktioner, paritet med facit og V2 i browser).

### Salgstempo: hvad beregningen bygger på
Serveren (`functions/_lib/salgstempo.js`) beregner et gennemsnitligt ugentligt salg pr. produkt (`rate`), som kalenderen bruger til at forudsige lagerets udvikling. Tallet er et estimat og bygger på disse antagelser:

1. **Salg er et mål for efterspørgsel.** Uger, hvor produktet var udsolgt, viser lavere salg end efterspørgslen, så tempoet kan være for lavt. Sådanne produkter flages `muligt_udsolgt`, hvis deres salg er højt nok til, at nuluger siger noget (se punkt 12).
2. **Fortiden forudsiger fremtiden.** Tempoet antager, at salget fremover ligner det seneste år. Vækst, tilbagegang, nye kanaler og kampagner indgår ikke.
3. **Vindue på 52 hele uger** (mandag–søndag). Uger uden salg tæller som 0. Et produkt, der er lanceret inden for året, beregnes kun fra første salg og flages `kort_historik`.
4. **Ét års data giver én observation pr. måned.** Det månedlige tempo (`maanedlig`) er derfor usikkert, og en enkelt usædvanlig uge kan slå stærkt igennem. Kalenderen bruger i første omgang kun årsgennemsnittet, som kan undervurdere højsæson og overvurdere lavsæson. Et månedstal beregnes kun, hvis produktet har salg i måneden og mindst 3 hele uger (mandag–søndag) med data i den, ellers er det `null`. Grænsen på 3 uger er et skøn, der skal valideres med ejeren. `maanedlig` kan altså indeholde `null`, og det skal V2 håndtere, når månedstallene tages i brug.
5. **Engangsordrer er ikke løbende salg.** Ordrer fra kanalerne event og b2b (hvis data indeholder kanal; Rackbeats ordrelinjer gør ikke) og enkeltordrer over 3 × produktets mediane ugesalg udelades af tempoet og rapporteres separat. De oprettes ikke automatisk som reservationer i kalenderen. Når produktets mediane ugesalg er 0, bruges medianen af uger med salg som grundlag for grænsen. Grænsen på 3 × er et skøn og bør justeres sammen med ejeren.
6. **Returvarer og kreditnotaer ignoreres.** Linjer med negativt antal trækkes ikke fra. Hvis returneringer er væsentlige, vil tempoet være for højt.
7. **Datoen er ordredatoen** (`order_date` i Rackbeat), ikke faktura- eller afsendelsesdatoen.
8. **SKU er nøglen.** Produkter, der er omdøbt, har skiftet varenummer eller er udfaset, kan ikke sammenlignes på tværs af perioden.
9. **Alle salgskanaler lægges sammen.** Der skelnes ikke mellem webshop, forhandlere og markeder, fordi Rackbeats ordrelinjer ikke har salgskanal.
10. **Enhed er styk pr. uge**, regnet på færdigvaren (en bar), ikke på batchstørrelse.
11. **Sikkerhed** er høj, middel eller lav. Grænser: høj = mindst 40 uger med salg og variationskoefficient under 0,6; lav = under 12 uger med salg eller variationskoefficient over 1,2; ellers middel. Grænserne er skønnede og bør valideres. Sikkerhed og flag beregnes og gemmes på produktet, men vises ikke i V2.
12. **Flag om udsolgt og lavt salg.** `muligt_udsolgt` sættes kun, hvis medianen af produktets uger med salg er mindst 3, og der er mindst 2 nuluger i træk efter en periode med salg. Produkter med en median under 3 får i stedet `lavt_salg`, uanset om de har nuluger, fordi nuluger er normale ved så lavt salg. Engangsordrer indgår ikke i medianen. Tærsklerne (median 3 og 2 nuluger) er skøn, der skal valideres med ejeren.

## Git-arbejdsgang
- `main` er altid fungerende. Nye ændringer sker i grene: `feature/<navn>`, merges via pull request.
- Commit-beskeder på dansk, korte og i nutid ("Tilføj sæbespåner-opgave").
- Tags markerer afleveringer: `iteration-1`, `iteration-2`, `iteration-3`.
