# Rackbeat live: opsætning

Denne vejledning sætter V2 op på Cloudflare Pages, så kalenderen viser aktuelt lager og salgstempo fra Rackbeat. Der er kun læseadgang. Antagelser og begrænsninger står i README under *Rackbeat live*.

Sådan hænger det sammen:

```
Browser (V2) ──login──▶ Cloudflare Access ──▶ Pages Functions (/api/status, /api/salgstempo) ──GET──▶ Rackbeat
                                                  nøglen ligger kun her, som secret
```

Repoet og GitHub Pages er offentlige. Derfor ligger nøglen aldrig i koden, og `/api` afviser alt uden gyldigt Access-login.

## 1. Rackbeat: nøgler

Rackbeat: *Firmaindstillinger > API > Opret nøgle*. Fjern fluebenet ved *Alle rettigheder*, og vælg kun det nødvendige.

| Secret | Rettighed i Rackbeat | Bruges til |
|---|---|---|
| `RACKBEAT_API_KEY` | *Tilgå ordrer* (access orders) | Ordrelinjer: salg de seneste 7 dage og salgstempo |
| `RACKBEAT_LAGER_KEY` (valgfri) | Adgang til produkter, se nedenfor | Lager (`GET /products`, feltet `stock_quantity`) |

**Lager:** Rackbeats dokumentation nævner ingen rettighed til produkter eller lager. Om en nøgle med kun *Tilgå ordrer* kan læse `GET /products`, er ikke afprøvet. Uden adgang svarer Rackbeat 401 eller 403. Så viser V2 rød pille ("mangler adgang til lager") og bruger estimeret lager, mens salgstempo stadig virker.
- Undersøg hos Rackbeat, hvilken rettighed der giver læseadgang til produkter. Lav en separat nøgle med kun den, og sæt den som `RACKBEAT_LAGER_KEY`.
- Brug ikke *Alle rettigheder* uden at have overvejet det. Koden laver kun GET-kald, men en lækket nøgle med alle rettigheder kan ændre og slette data i Rackbeat.

## 2. Cloudflare Pages-projekt

1. Cloudflare-dashboardet: *Workers & Pages > Create > Pages > Connect to Git*. Vælg repoet `FrejTR/DTV-gruppe-10`.
2. Byggeindstillinger:
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** tom
   - **Build output directory:** `src`
   - **Root directory:** tom (repoets rod, hvor mappen `functions/` ligger)
3. Gem og byg. Mappen `functions/` bliver automatisk til `/api/status` og `/api/salgstempo`. Statiske filer går ikke gennem funktionerne.
4. Plan: Workers Free tillader 50 kald og 10 ms CPU pr. forespørgsel. `/api/status` holder sig under det. `/api/salgstempo` henter én side pr. 100 ordrelinjer og bruger ca. 7 ms CPU alene på beregningen (eksempeldata), så det kræver i praksis **Workers Paid**. På Paid kan sidegrænsen hæves med variablen `SALGSTEMPO_MAX_SIDER` (standard 40).

## 3. Cloudflare Access (login)

Access skal beskytte både `<projekt>.pages.dev` og preview-adresserne.

1. Pages-projektet: *Settings > General > Enable access policy*. Det beskytter preview-adresserne.
2. Beskyt også `<projekt>.pages.dev` efter Cloudflares vejledning *Enable access on your pages.dev domain* (developers.cloudflare.com/pages/platform/known-issues/):
   1. Vælg *Manage* på den Access-politik, der lige er oprettet.
   2. Vælg projektet under *Access > Applications* og *Configure*.
   3. Fjern stjernen (wildcard) i feltet *Subdomain* under *Public hostname*, og gem. Ret evt. *Application name*.
   4. Gå tilbage til *Settings > General*, og vælg *Enable access policy* igen, så preview-adresserne også er beskyttet.
   5. Kontrollér, at der nu er to Access-applikationer: én for `<projekt>.pages.dev` og én for preview-adresserne.
3. Politik: *Allow* med *Include > Emails* for de medarbejdere, der skal bruge kalenderen. Login med engangskode (One-time PIN) til e-mail kræver ingen andre konti.
4. Find to værdier, som funktionerne skal bruge til at tjekke tokenet:
   - **Team domain:** `https://<team>.cloudflareaccess.com` (Zero Trust: *Settings*, team-navnet).
   - **AUD-tag:** *Zero Trust > Access controls > Applications*. Vælg *Edit* på applikationen for `<projekt>.pages.dev`, og kopiér *Application Audience (AUD) Tag* under *Additional settings*.

Funktionerne tjekker selv tokenet i headeren `Cf-Access-Jwt-Assertion`: signatur (RS256 mod Cloudflares offentlige nøgler), udsteder (team-domænet), audience (AUD-tagget) og udløb. Mangler opsætningen, afviser de alle kald.

## 4. Variabler og secrets i Pages

Pages-projektet: *Settings > Variables and Secrets > Add*. Vælg *Encrypt* ved nøglerne. Sæt dem for **Production** (og Preview, hvis previews skal kunne hente data).

| Navn | Type | Værdi |
|---|---|---|
| `RACKBEAT_API_KEY` | Secret | Nøglen med *Tilgå ordrer* |
| `RACKBEAT_LAGER_KEY` | Secret (valgfri) | Nøglen til lager |
| `CF_ACCESS_TEAM_DOMAIN` | Variabel | `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Variabel | AUD-tagget |
| `SALGSTEMPO_MAX_SIDER` | Variabel (valgfri) | Fx `200` på Workers Paid |

Sæt **aldrig** `LOKAL_UDVIKLING_UDEN_ACCESS` eller `RACKBEAT_BASE_URL` i Cloudflare. De er kun til lokal udvikling og virker kun på `localhost` og `127.0.0.1`.

Byg projektet igen efter ændringer (*Deployments > Retry deployment*), så de nye værdier tages i brug.

## 5. Kontrol efter udrulning

1. Åbn `https://<projekt>.pages.dev/v2/produktionskalender-v2.html` i et privat vindue. Du skal først møde Access-login.
2. Efter login skal pillen i sidefoden blive grøn: "Rackbeat: opdateret hh:mm:ss". Under *Produkter og minimum* står "Rackbeat, hh:mm:ss" ved lager og salgstempo.
3. Hvis pillen er rød:

   | Pillen viser | Årsag |
   |---|---|
   | "mangler adgang til lager" | Nøglen kan ikke læse produkter (afsnit 1) |
   | "fejl" | Se *Deployments > Functions*-loggen for koden, fx `noegle_afvist` eller `ikke_sat_op` |
   | "log ind igen" | Access-sessionen er udløbet. Genindlæs siden |

4. Uden login skal `curl https://<projekt>.pages.dev/api/status` give en omdirigering til Access-login, ikke data.

Loggen indeholder kun korte koder og HTTP-status, aldrig nøgler, headers eller svar fra Rackbeat.

## 6. Lokal udvikling og test

Kræver Node 18 eller nyere. Wrangler hentes med `npx` og skal ikke installeres i projektet.

**Uden nøgle, med mock af Rackbeat:**
1. Kopiér `.dev.vars.example` til `.dev.vars`, og udfyld:
   ```
   RACKBEAT_API_KEY=lokal-test
   LOKAL_UDVIKLING_UDEN_ACCESS=ja
   RACKBEAT_BASE_URL=http://127.0.0.1:8790
   ```
2. Start mocken og serveren i hver sin terminal:
   ```
   node tests/mock_rackbeat.js
   npx wrangler pages dev src
   ```
3. Åbn `http://localhost:8788/v2/produktionskalender-v2.html`.

Mocken leverer eksempeldata i Rackbeats format. `MOCK_LAGER_STATUS=403 node tests/mock_rackbeat.js` efterligner en nøgle uden lageradgang.

**Med rigtig nøgle:** skriv nøglen i `.dev.vars`, og fjern linjen `RACKBEAT_BASE_URL`. `.dev.vars` er i `.gitignore`. Kontrollér alligevel med `git status`, før du committer.

**Automatiske test (kræver ingen nøgle):**
```
node --test "tests/*.test.mjs"   # serverfunktioner, Access-tjek og paritet med Python-scriptet
node tests/live_v2.js            # V2 i browser: polling, backoff, dialoger, statuspille
npm test                         # røgtest af V1 og V2
python -m pytest tests/          # Python-scriptet
```

## Kilder

| Emne | Side |
|---|---|
| Rackbeat API | developer.rackbeat.com: Authentication, Pagination, Errors & Rate Limits (480 kald i minuttet pr. konto), Optimizing Queries (`fields`), List Lines for all Orders (`GET /orders/lines`), List Products (`GET /products`) |
| Access-token | developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ |
| Pages | developers.cloudflare.com/pages/functions/bindings/, …/configuration/preview-deployments/, …/platform/known-issues/ |
| Grænser | developers.cloudflare.com/workers/platform/limits/ |
