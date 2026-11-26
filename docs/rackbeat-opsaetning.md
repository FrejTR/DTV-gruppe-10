# Rackbeat live: opsætning på Vercel

Denne vejledning sætter V3 op på Vercel, så kalenderen viser aktuelt lager og salgstempo fra Rackbeat. Når en batch markeres som pakket, lægges det godkendte antal på Hovedlager i Rackbeat som en lagerregulering (afsnit 7). Ellers er der kun læseadgang. Antagelser og begrænsninger står i README under *Rackbeat live*.

Sådan hænger det sammen:

```
Browser (V3) ──▶ Vercel Deployment Protection (login) ──▶ /api/status, /api/salgstempo ──GET──▶ Rackbeat
                                                              nøglen ligger kun her, som Secret
```

Repoet er offentligt. Derfor ligger nøglen aldrig i koden. Funktionerne tjekker ikke selv, hvem der kalder: det gør Vercel, før kaldet når funktionen. **Er beskyttelsen slået fra eller sat forkert, er `/api` åben for alle.** Afsnit 3 og 5 er derfor vigtigst.

## 1. Rackbeat: nøgler

Rackbeat: *Firmaindstillinger > API > Opret nøgle*. Fjern fluebenet ved *Alle rettigheder*, og vælg kun det nødvendige.

| Variabel | Rettighed i Rackbeat | Bruges til |
|---|---|---|
| `RACKBEAT_API_KEY` | *Tilgå ordrer* (access orders) og ret til lagerreguleringer | Læsning: ordrelinjer (salgstempo, `GET /orders/lines`) og produkter (lager, `GET /products`, feltet `stock_quantity`). Skrivning: godkendte batches lægges på lager (`POST /inventory-adjustments`, se afsnit 7) |

- Rackbeats dokumentation nævner ingen særskilt rettighed til produkter. Jeres nøgle med *Tilgå ordrer* kunne læse lager i produktionen 9. november 2026 (grøn pille). Mangler en nøgle adgang, svarer Rackbeat 403, og kalenderen viser rød pille ("mangler adgang til lager"), mens salgstempo stadig virker.
- Brug ikke *Alle rettigheder* uden at have overvejet det. Koden skriver kun lagerreguleringer. En lækket nøgle med alle rettigheder kan ændre og slette data i Rackbeat.

## 2. Vercel-projekt

1. Log ind på vercel.com med GitHub. *Add New > Project*, og vælg repoet `FrejTR/DTV-gruppe-10`.
2. Indstillingerne kommer fra `vercel.json` i repoet og skal ikke ændres: *Framework Preset* Other, ingen build-kommando, *Output Directory* `src`. Mappen `api/` bliver til funktionerne `/api/status` og `/api/salgstempo`. Rod-mappen er repoets rod.
3. **Production Branch** er `main`. Indtil grenen er merget, findes koden kun i preview-udgaver. Hver gren får sin egen adresse med formen `<projekt>-git-<gren>-<konto>.vercel.app`, og den vises i Vercel under *Deployments*.
4. **Plan:** Hobby er gratis, men kun til ikke-kommerciel, personlig brug (Vercels *fair use guidelines*), og der kan kun gives adgang til én ekstern bruger udover dig selv. Skal flere medarbejdere bruge kalenderen, eller skal den bruges i driften hos Kystnær, kræver det Pro.

## 3. Beskyttelse (Deployment Protection)

Projektet: *Settings > Deployment Protection*.

1. Slå **Vercel Authentication** til.
2. Vælg beskyttelsesniveauet **All Deployments**, og gem. Det er afgørende: standardniveauet *Standard Protection* beskytter ikke produktions-adressen. Så ville `https://<projekt>.vercel.app/api/status` være åben for alle, også selv om forhåndsvisninger er beskyttet.
3. Du har selv adgang som ejer af kontoen. Andre skal logge ind med en Vercel-konto og bede om adgang. Du godkender det under *Settings > Deployment Protection > Requests*. På Hobby kan det kun være én person.

Vercel Authentication er gratis på alle planer. Password Protection (fælles adgangskode) kræver Pro og koster 20 USD om måneden pr. projekt.

## 4. Miljøvariabler

Projektet: *Settings > Environment Variables > Add*. Vælg typen **Secret** til nøglerne (skrivebeskyttet efter gem). Sæt dem for **Production** og **Preview**.

| Navn | Type | Værdi |
|---|---|---|
| `RACKBEAT_API_KEY` | Secret | Nøglen med *Tilgå ordrer* |
| `SALGSTEMPO_MAX_SIDER` | Config (valgfri) | Højeste antal sider ordrelinjer (standard 200, ca. 20.000 linjer) |
| `SUPABASE_URL` | Config | `https://azfzbsfwbnwcjmkmzrxz.supabase.co` (afsnit 8) |
| `SUPABASE_SECRET_KEY` | Secret | Den hemmelige nøgle fra Supabase, `sb_secret_...` (afsnit 8) |

Sæt **aldrig** `RACKBEAT_BASE_URL`. Den er kun til lokal udvikling og ignoreres på Vercel.

Ændringer gælder kun nye udrulninger. Brug *Deployments > Redeploy* efter ændringer.

## 5. Kontrol efter udrulning

1. Åbn `https://<projekt>.vercel.app/v3/produktionskalender-v3.html` i et privat vindue. Du skal først møde Vercels login.
2. **Kontrollér, at API'et er lukket.** I terminalen, uden login:
   ```
   curl -i https://<projekt>.vercel.app/api/status
   ```
   Du skal få `401` eller en omdirigering til Vercels login, aldrig data. Får du JSON med `lager` eller `salg`, er beskyttelsen ikke slået til på det niveau. Slå *All Deployments* til med det samme, og tjek også adressen til den enkelte udrulning (`<projekt>-<hash>-<konto>.vercel.app`) og grenens adresse.
3. Efter login skal pillen i sidefoden blive grøn: "Rackbeat: opdateret hh:mm:ss". Under *Produkter og minimum* står "Rackbeat, hh:mm:ss" ved lager og salgstempo.
4. Hvis pillen er rød:

   | Pillen viser | Årsag |
   |---|---|
   | "mangler adgang til lager" | Nøglen kan ikke læse produkter (afsnit 1) |
   | "fejl" | Se *Logs* i Vercel for koden, fx `noegle_afvist` eller `ikke_sat_op` (nøglen mangler, eller udrulningen er ikke bygget igen efter at den blev sat) |
   | "log ind igen" | Login til Vercel er udløbet. Genindlæs siden |

Loggen indeholder kun korte koder og HTTP-status, aldrig nøgler, headers eller svar fra Rackbeat.

## 6. Lokal udvikling og test

Kræver Node 18 eller nyere. Der skal ikke bruges Vercel-konto lokalt.

**Uden nøgle, med mock af Rackbeat:**
1. Opret `.env` ud fra `.env.example`, og udfyld (en mock-nøgle, ikke en rigtig):
   ```
   RACKBEAT_API_KEY=lokal-test
   RACKBEAT_BASE_URL=http://127.0.0.1:8790
   ```
2. Start mocken og den lokale server i hver sin terminal:
   ```
   npm run mock
   npm start
   ```
3. Åbn `http://127.0.0.1:8788/v3/produktionskalender-v3.html`.

Den lokale server kører de samme funktioner som Vercel, men uden login, og lytter kun på `127.0.0.1`. `MOCK_LAGER_STATUS=403 npm run mock` efterligner en nøgle uden lageradgang.

**Fælles data lokalt:** `node tests/supabase_pglite.mjs` starter en rigtig Postgres i hukommelsen (PGlite) med migrationerne fra `supabase/migrations/` og svarer som Supabase på `http://127.0.0.1:8792`. Skriv `SUPABASE_URL=http://127.0.0.1:8792` og `SUPABASE_SECRET_KEY=lokal-db` i `.env`. Data forsvinder, når den stoppes.

**Med rigtig nøgle:** skriv nøglen i `.env`, og fjern linjen `RACKBEAT_BASE_URL`. `.env` er i `.gitignore`. Kontrollér alligevel med `git status`, før du committer.

**Automatiske test (kræver ingen nøgle):** `npm test` kører
- røgtest af V1, V2 og V3,
- serverfunktionerne og pariteten med facit fra det oprindelige Python-script (`node --test "tests/*.test.mjs"`), herunder `/api/data` og `/api/pak` mod en rigtig Postgres (PGlite) med migrationerne,
- kalenderen i browser, for både den frosne V2 og V3: polling, backoff, dialoger, statuspille og starttilstand (`node tests/live_v2.js` og `node tests/live_v3.js`),
- pakning → lagerregulering, hele vejen mod mocken (`node tests/pak_rackbeat.js` for V2, og `node tests/pak_rackbeat_v3.js` for V3's produktionslager med to kalendere og lokal database).

## 7. Godkendte batches lægges på lager

> Dette afsnit gælder den frosne V2 (`/api/lagerregulering`). V3 pakker fra produktionslageret med `/api/pak`, se afsnit 8. Reguleringen i Rackbeat er den samme.

Når en batch markeres som *Pakket* i kalenderen på Vercel, spørger kalenderen: "Læg 53 stk. på Hovedlager i Rackbeat?". Ved ja sender den `POST /api/lagerregulering`, og serveren opretter en lagerregulering i Rackbeat:

| Felt i Rackbeat | Værdi | Hvorfor |
|---|---|---|
| Lokation | 1001 (Hovedlager) | Kystnærs standardlokation |
| Antal | Godkendt antal (lavet minus kasseret) | |
| Antal | **Nuværende beholdning på Hovedlager + godkendt antal** (`regulate_diff: false`) | Rackbeat *sætter* beholdningen til det sendte antal (se herunder). Derfor læses beholdningen først, så resultatet er "læg til" |
| Kategori | 1004 (Produktion) | |
| Årsag og beskrivelse | "Batch #32 godkendt" og en reference | Referencen forhindrer, at samme batch registreres to gange |
| Bogføring | Ja, straks efter oprettelsen (`POST /inventory-adjustments/{id}/book`) | En regulering er en kladde, indtil den er bogført, og ændrer først beholdningen derefter |

Batchen markeres først som pakket, når Rackbeat har bekræftet. En batch, der er lagt på lager, kan ikke fortrydes i kalenderen. Er antallet forkert, rettes det i Rackbeat. Uden server (fil, `npm start`, GitHub Pages) pakkes kun i kalenderen som før.

Sikring:
- Der bruges én nøgle, `RACKBEAT_API_KEY`, til både læsning og skrivning.
- Funktionen godtager kun kald fra kalenderen selv (samme `Origin`, JSON). En anden side kan ikke få en indlogget brugers browser til at oprette reguleringer.
- Antal skal være et helt tal fra 1 til 10.000, og varenummeret må kun indeholde bogstaver, tal og `._:-`.
- Et POST sendes aldrig igen automatisk. Prøver brugeren igen, finder serveren den første regulering ud fra referencen.
- **Læg til, aldrig overskriv.** Med `regulate_diff: false` sætter Rackbeat beholdningen til det sendte antal, når reguleringen bogføres. Det viste de første rigtige pakninger 16. november 2026: 22, 10 og 5 stk. sendt ved 24 på lager blev bogført som −2, −14 og −19. Rackbeats dokumentation beskriver ikke feltet. Derfor læser serveren beholdningen på Hovedlager (`GET /products/{varenr}/locations`) lige før, sender nuværende + godkendt, bogfører straks og kontrollerer bagefter, at den bogførte ændring blev præcis +godkendt. Afviger den (fx et salg i samme sekund), viser kalenderen en advarsel om at tjekke beholdningen.
- **En gammel kladde bogføres aldrig.** Den sætter beholdningen ud fra lageret dengang. Findes en kladde fra et tidligere forsøg, slettes den, og der laves en ny ud fra lageret nu. Fejler bogføringen, slettes kladden, og stk. gives tilbage til produktionslageret.
- Rackbeats liste over reguleringer viser som standard kun kladder. Serveren søger derfor efter referencen i både bogførte (`is_booked=true`) og kladder, for varen og fra pakkedagen.

**Første gang med rigtig nøgle (uafprøvet mod Rackbeat):** Feltnavnene er fra Rackbeats dokumentation og Kystnærs egne reguleringer, men skrivning er kun afprøvet mod mocken. Rackbeat har ikke et testmiljø.
1. Pak en lille batch af én vare. Tjek i Rackbeat under *Beholdning > Reguleringer*, at beholdningen er steget med antallet (ikke sat til det), at lokationen er Hovedlager, og at kategorien er Produktion.
2. Gik noget galt, så ret beholdningen i Rackbeat, og pak ikke flere batches på Vercel, indtil fejlen er fundet.

## 8. Fælles data og produktionslager (V3)

Batches, bestillinger, personer og produktindstillinger (minimum, typisk batch, dage før pakning, trin) deles af alle, der bruger kalenderen. De ligger i Supabase-projektet `kystnaer-produktionskalender` (Frankfurt). Kun Vercel-serveren taler med databasen, med den hemmelige nøgle. Browseren har ingen nøgle.

**Opsætning (én gang):**
1. Databasen er oprettet med `supabase/migrations/20261116100000_faelles_data.sql` (kørt i Supabases *SQL Editor* 16. november 2026). Nye migrationer køres på samme måde.
2. I Supabase: *Project Settings > API Keys*. Kopiér en **secret key** (`sb_secret_...`). Brug ikke den offentlige *publishable key*: den kan hverken læse eller skrive her.
3. I Vercel-projektet (`dtv-gruppe-10-8u5t`): sæt `SUPABASE_URL` og `SUPABASE_SECRET_KEY` (afsnit 4), og vælg *Redeploy*.
4. Åbn V3. Pillen i sidefoden skal vise "Fælles data: gemt". Den første kalender, der åbnes, sender sine data op, fordi databasen er tom. Alle andre henter derefter dataene fra databasen.

| Pillen viser | Årsag |
|---|---|
| "Fælles data: ikke sat op" | `SUPABASE_URL` eller `SUPABASE_SECRET_KEY` mangler, eller udrulningen er ikke bygget igen. Data gemmes kun i browseren imens |
| "Fælles data: fejl" | Se *Logs* i Vercel, fx `db_noegle_afvist`. Prøver igen hvert 20. sekund |

**Sådan deles data:** Kalenderen henter alle data (`GET /api/data`) hvert 20. sekund og sender kun det, der er ændret (`POST /api/data`). Ændringer, der ikke er sendt endnu, vinder over det, serveren sender. Retter to personer det samme samtidig, gælder den sidste. Et produkt kan slettes helt (*Produkter og minimum > Slet*), men kun når der ikke er batches, bestillinger eller pakninger på det. Serveren tjekker det også. Ellers arkiveres det.

**Produktionslager:** alt, der er lavet, men ikke pakket. Afsnittet *Produktionslager* viser pr. produkt, hvad der hærder, hvad der er klar til pakning, og i alt. *Pak* åbner en dialog, hvor medarbejderen skriver, hvor mange stk. der er taget ud, og hvor mange af dem der er kasseret. Ved *Pak og læg på lager* sender kalenderen `POST /api/pak`, og serveren
1. tager stk. fra de batches, der er klar, ældste først (låst i databasen, så to kalendere ikke kan tage de samme stk.),
2. opretter og bogfører en lagerregulering i Rackbeat med det godkendte antal (taget ud minus kasseret), som i afsnit 7, med årsagen "Pakket fra batch #32",
3. markerer pakningen som bogført.

Kun batches, der har hærdet færdigt, kan pakkes. Er der ikke nok klar, afvises pakningen med antallet, der er klar. Kasserede stk. tæller med på listen over sæbespåner, hvis produktet er en sæbe med *Skær kanter og sæbespåner* slået til (under *Produkter og minimum*). Er det slået fra, har produktet hverken trinet "Skær kanter" eller sæbespåner. Afviser Rackbeat, gives stk. tilbage til produktionslageret. Svarer Rackbeat ikke, eller er reguleringen oprettet, men ikke bogført, bliver stk. stående som "venter på Rackbeat" med knappen *Prøv igen*. Et nyt forsøg bruger samme reference, så Rackbeat aldrig får reguleringen to gange.

Sikring: tabellerne har række-sikkerhed (RLS) uden regler, og funktionerne kan kun kaldes med den hemmelige nøgle. Serveren godtager kun kald fra kalenderen selv og tjekker alle felter (fx at datoer er datoer og antal er hele tal), så produktionslageret altid kan regnes.

**Afsluttede batches:** en batch, der har været "Pakket og lagt i Rackbeat" i 7 dage, skjules på listen *Batches* (knappen *Vis afsluttede* viser dem igen). Den slettes ikke og bliver i kalenderen og beregningerne.

## 9. Historik (fejlfinding)

**Batchnummer:** Når en batch registreres som lavet, får den sit nummer ud fra datoen: K + dag + måned + år talt fra 2020 (fx lavet 26-11-2026 → K261106; 2027 → 07, 2030 → 10). Alle produkter lavet samme dag får samme nummer. Laves samme produkt flere gange samme dag, får de næste -02, -03 osv. Planlagte batches har intet nummer, før de registreres. Nummeret kan altid rettes i hånden; et selvskrevet nummer ændres ikke, hvis datoen rettes.

Fanen *Historik* nederst på siden viser alt, der er oprettet, ændret, pakket eller slettet, fra alle kalendere, nyeste først. Hver linje har tidspunkt (med sekunder), kategori, hvad der skete, de ændrede værdier (før → efter, og rå data under *Data*) og hvorfra (browser, styresystem og et tilfældigt id pr. browser, så man kan se, om to linjer kom fra samme computer). Man kan filtrere på kategori (batches, pakning, bestillinger, produkter, personer, fejl) og søge, fx på et batchnummer eller et navn.

- Serveren skriver historikken, ikke browseren: ved hver `POST /api/data` sammenligner den data før og efter, og linjerne gemmes i samme transaktion som ændringen (`gem_data`). En ændring, der ikke blev gemt, står derfor heller ikke i historikken.
- Pakninger logges med antal, kasserede, hvilke batches stk. blev taget fra, Rackbeat-reguleringens nummer og beholdningen på Hovedlager før og efter. Står der *Advarsel*, ændrede Rackbeat beholdningen med et andet tal end det godkendte (fx et salg i samme sekund).
- Fejl ved pakning logges under *Fejl*: Rackbeat afviste (stk. tilbage på produktionslageret), Rackbeat svarede ikke (stk. venter på *Prøv igen*), eller der var ikke nok klar.
- Lager og salgstempo, som hentes fra Rackbeat hvert 20. sekund, logges ikke.
- Linjer ændres eller slettes aldrig. Tabellen er `historik` i Supabase (migration `20261126110000_historik.sql`), og den hentes med `GET /api/historik` (100 linjer ad gangen, `foer`, `kategori`, `soeg`).
- Historikken kræver den fælles database. Åbnet som fil viser fanen kun en forklaring.

**Hvem gjorde det:** hver handling med en batch eller vare har et navn.
- Dialogerne spørger, udfyldt med det sidst valgte navn: *Lavet af* / *Planlagt af* (registrér batch), *Udført af* (tag ud af forme, skær kanter, sæbespåner), *Pakket af* (pak og læg på lager), *Kasseret af* (marker som fejlet), *Rettet af* (ret batch), *Slettet af* (slet batch) og *Oprettet af* (bestilling/event og nyt produkt).
- Navnet gemmes på data, hvor det hører til: pakningen (`pakninger.af`), kassationen, sidste rettelse af batchen, kasserede stk. og bestillingen. Det vises i batchens detaljer og i bestillingslisten.
- Små ændringer direkte i tabellerne (kasserede, minimum, dage før pakning, gendan, fortryd, arkivér/slet produkt, slet bestilling) bruger *Bruger* øverst på siden. Er der ikke valgt nogen, spørger siden først. Brugeren huskes i browseren og skifter, når man vælger et andet navn i en dialog.
- Historikken har kolonnen *Hvem* med navnet og computeren. Der kan søges på navnet. Linjer fra før 26. november 2026 står som *Ukendt*.
- Migration `20261126120000_ansvarlig.sql` tilføjer `pakninger.af` og `historik.person`.

## Kilder

| Emne | Side |
|---|---|
| Rackbeat API | developer.rackbeat.com: Authentication, Pagination, Errors & Rate Limits (480 kald i minuttet pr. konto), Optimizing Queries (`fields`), List Lines for all Orders (`GET /orders/lines`), List Products (`GET /products`), Create Inventory Adjustment (`POST /inventory-adjustments`) |
| Beskyttelse | vercel.com/docs/deployment-protection, …/methods-to-protect-deployments/vercel-authentication, …/password-protection |
| Funktioner | vercel.com/docs/functions/runtimes/node-js, vercel.com/docs/functions/limitations |
| Variabler og planer | vercel.com/docs/environment-variables, vercel.com/docs/plans/hobby |
