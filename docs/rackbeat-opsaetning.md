# Rackbeat live: opsætning på Vercel

Denne vejledning sætter V2 op på Vercel, så kalenderen viser aktuelt lager og salgstempo fra Rackbeat. Der er kun læseadgang. Antagelser og begrænsninger står i README under *Rackbeat live*.

Sådan hænger det sammen:

```
Browser (V2) ──▶ Vercel Deployment Protection (login) ──▶ /api/status, /api/salgstempo ──GET──▶ Rackbeat
                                                              nøglen ligger kun her, som Secret
```

Repoet og GitHub Pages-kopien er offentlige. Derfor ligger nøglen aldrig i koden. Funktionerne tjekker ikke selv, hvem der kalder: det gør Vercel, før kaldet når funktionen. **Er beskyttelsen slået fra eller sat forkert, er `/api` åben for alle.** Afsnit 3 og 5 er derfor vigtigst.

## 1. Rackbeat: nøgler

Rackbeat: *Firmaindstillinger > API > Opret nøgle*. Fjern fluebenet ved *Alle rettigheder*, og vælg kun det nødvendige.

| Variabel | Rettighed i Rackbeat | Bruges til |
|---|---|---|
| `RACKBEAT_API_KEY` | *Tilgå ordrer* (access orders) | Ordrelinjer: salg de seneste 7 dage og salgstempo |
| `RACKBEAT_LAGER_KEY` (valgfri) | Adgang til produkter, se nedenfor | Lager (`GET /products`, feltet `stock_quantity`) |

**Lager:** Rackbeats dokumentation nævner ingen rettighed til produkter eller lager. Om en nøgle med kun *Tilgå ordrer* kan læse `GET /products`, er ikke afprøvet. Uden adgang svarer Rackbeat 401 eller 403. Så viser V2 rød pille ("mangler adgang til lager") og bruger estimeret lager, mens salgstempo stadig virker.
- Undersøg hos Rackbeat, hvilken rettighed der giver læseadgang til produkter. Lav en separat nøgle med kun den, og sæt den som `RACKBEAT_LAGER_KEY`.
- Brug ikke *Alle rettigheder* uden at have overvejet det. Koden laver kun GET-kald, men en lækket nøgle med alle rettigheder kan ændre og slette data i Rackbeat.

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
| `RACKBEAT_LAGER_KEY` | Secret (valgfri) | Nøglen til lager |
| `SALGSTEMPO_MAX_SIDER` | Config (valgfri) | Højeste antal sider ordrelinjer (standard 200, ca. 20.000 linjer) |

Sæt **aldrig** `RACKBEAT_BASE_URL`. Den er kun til lokal udvikling og ignoreres på Vercel.

Ændringer gælder kun nye udrulninger. Brug *Deployments > Redeploy* efter ændringer.

## 5. Kontrol efter udrulning

1. Åbn `https://<projekt>.vercel.app/v2/produktionskalender-v2.html` i et privat vindue. Du skal først møde Vercels login.
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
   node tests/mock_rackbeat.js
   node tests/dev_server.mjs
   ```
3. Åbn `http://127.0.0.1:8788/v2/produktionskalender-v2.html`.

Den lokale server kører de samme funktioner som Vercel, men uden login, og lytter kun på `127.0.0.1`. `MOCK_LAGER_STATUS=403 node tests/mock_rackbeat.js` efterligner en nøgle uden lageradgang.

**Med rigtig nøgle:** skriv nøglen i `.env`, og fjern linjen `RACKBEAT_BASE_URL`. `.env` er i `.gitignore`. Kontrollér alligevel med `git status`, før du committer. Samme `.env` bruges af Python-scripts.

**Automatiske test (kræver ingen nøgle):**
```
node --test "tests/*.test.mjs"   # serverfunktioner og paritet med Python-scriptet
node tests/live_v2.js            # V2 i browser: polling, backoff, dialoger, statuspille
npm test                         # røgtest af V1 og V2
python -m pytest tests/          # Python-scriptet
```

## Kilder

| Emne | Side |
|---|---|
| Rackbeat API | developer.rackbeat.com: Authentication, Pagination, Errors & Rate Limits (480 kald i minuttet pr. konto), Optimizing Queries (`fields`), List Lines for all Orders (`GET /orders/lines`), List Products (`GET /products`) |
| Beskyttelse | vercel.com/docs/deployment-protection, …/methods-to-protect-deployments/vercel-authentication, …/password-protection |
| Funktioner | vercel.com/docs/functions/runtimes/node-js, vercel.com/docs/functions/limitations |
| Variabler og planer | vercel.com/docs/environment-variables, vercel.com/docs/plans/hobby |
