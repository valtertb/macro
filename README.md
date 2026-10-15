# MACRO DAILY BIAS TERMINAL (zadarmo, lokálne)

Deterministické makro skóre od **−10 do +10** pre **NQ**, **Zlato (GC/XAU)** a **EUR/USD**, počítané z verejných zdrojov. Beží lokálne, bez platených dát, bez cloudu a bez LLM.

**Čo to JE:** denný makro kontext (politika Fedu/ECB, výnosy, USD, prekvapenia v dátach, rizikový sentiment) s vysvetlením, istotou a viditeľnou aktuálnosťou každého vstupu.
**Čo to NIE JE:** real-time ani intraday signál. Všetky vstupy sú denné alebo mesačné. Skóre je kontext pre Pre-Market Routine, nie dôvod na vstup do obchodu.

## Webová verzia (GitHub Pages, zadarmo)

GitHub Actions spúšťa `.github/workflows/update.yml` v pracovné dni podľa obchodných session (čas Bratislava, GitHub môže štart o 5–15 min oneskoriť):

- pred London open 09:00: 2 behy ráno,
- okolo poludnia: denné dáta ECB,
- od 14:00 do NY open 15:30: každých 15 min, pretože dáta z USA (CPI, NFP…) vychádzajú o 14:30,
- večer po zatvorení USA.

Častejšie spúšťanie nedáva zmysel: bezplatné zdroje sú denné alebo mesačné. Výnosy z FRED meškajú 1–2 pracovné dni.

Workflow:

1. spustí testy,
2. stiahne dáta z FRED a ECB,
3. prepočíta skóre,
4. uloží históriu do `data/history.json` (commit iba pri zmene vstupov),
5. zverejní stránku na `https://<user>.github.io/<repo>/`.

Ručná aktualizácia: tlačidlo **Obnoviť dáta (GitHub)** na stránke, potom **Run workflow**.

Jednorazové nastavenie:

1. Repo musí byť **public**, inak GitHub Pages nie je zadarmo.
2. Settings → Secrets and variables → Actions → **New repository secret** s názvom `FRED_API_KEY`.
3. Settings → Pages → Source: **GitHub Actions**.

Na verejnej stránke sa nezverejňujú surové hodnoty sérií © CBOE (VIX) a © ICE BofA (HY OAS). Vstupujú iba do skóre. Ak sa v repe 60 dní nič nezmení, GitHub naplánované behy pozastaví. Commity histórie to zvyčajne zabránia, a ak sa to stane, workflow stačí znova zapnúť v záložke Actions.

## Lokálne spustenie

Potrebuješ **Node.js ≥ 22.18** (`node -v`). Nič sa neinštaluje (`npm install` netreba).

1. Získaj **zadarmo** FRED API kľúč: <https://fredaccount.stlouisfed.org/apikeys>
2. `cp .env.example .env` a vlož kľúč do `FRED_API_KEY=`
3. **Over zdroje** (nič sa neukladá): `npm run check-sources`
4. `npm start` a otvor <http://localhost:3000>, potom stlač **Obnoviť dáta**

Ďalšie príkazy: `npm run refresh` (jednorazové načítanie + prepočet), `npm test`.

Server počúva len na `127.0.0.1`, kontroluje hlavičku Host a obnovenie cez POST vyžaduje vlastnú hlavičku. Dáta sa automaticky obnovujú každých `REFRESH_MINUTES` (60), v dňoch s vydaním dát alebo rozhodnutím centrálnej banky každých `RELEASE_DAY_REFRESH_MINUTES` (15).

## Zdroje dát

| Dáta | Zdroj | Kľúč | Frekvencia / oneskorenie |
|---|---|---|---|
| Fed Funds, US 2Y/10Y, 10Y reálny výnos, široký USD index, VIX, HY OAS, Core CPI, NFP, nezamestnanosť | FRED API | zadarmo, povinný (120 volaní/min) | denné / mesačné, **nie real-time**; USD index má oneskorenie |
| Eurozóna 2Y/10Y výnos (AAA krivka), core HICP, depozitná sadzba, EUR/USD ref. kurz | ECB Data Portal (SDMX) | netreba | denné / mesačné |
| Kalendár vydaní USA | FRED `releases/dates` | rovnaký kľúč | dátumy bez presného času |
| FOMC a ECB rozhodnutia | manuálny zoznam v `src/config.ts` | – | **overené 15. 10. 2026** na federalreserve.gov a ecb.europa.eu, raz ročne treba skontrolovať |

BLS, BEA a Treasury priamo nepoužívame: FRED sprístupňuje tie isté ukazovatele (CPI, zamestnanosť, výnosy) v jednom rozhraní. Eurostat v MVP nie je.

**Stav overenia:** FRED a ECB som mohol overiť len podľa dokumentácie. Z build sandboxu boli oba hostitelia zablokovaní, takže **živé volania neboli otestované**. ECB kľúče sérií v `src/config.ts` sú preto neoverené, kým nespustíš `npm run check-sources`. Zlyhanie jedného zdroja nezhodí ostatné a v UI je viditeľné.

## Ako sa skóre počíta

1. **Signály** (asset-neutrálne), každý ako robustné z-skóre: `z = (x − median) / (1.4826·MAD)`, orezané na ±3; ak je história krátka alebo MAD = 0, použije sa documented fallback, inak je faktor **nedostupný** (nikdy nie 0). Okno 750 pozorovaní (denné) / 60 mesiacov (mesačné).
2. **Faktor** = `10·tanh(z/2)` so znamienkom podľa aktíva (napr. rastúce reálne výnosy: Zlato −, NQ −, EUR/USD cez USD −).
3. **Skóre** = `Σ w·s / pokrytie`, orezané na ±10, zobrazené na 1 desatinné miesto, medzivýsledky sa nezaokrúhľujú.
4. **Váhy** (hypotézy, nie validované):

| Aktívum | Faktory (váha) |
|---|---|
| NQ | politika Fedu 30 %, výnosy 25 %, USD 10 %, prekvapenia 20 %, riziko 15 % |
| Zlato | politika Fedu 20 %, reálne výnosy 30 %, USD 25 %, prekvapenia 10 %, riziko 15 % |
| EUR/USD | Fed vs ECB 30 %, rozdiel výnosov 15 %, USD 30 %, relatívne prekvapenia 20 %, riziko 5 % |

5. **Pokrytie:** ≥ 85 % normálne, 70–85 % provizórne (znížená istota), < 70 % alebo chýbajúci kľúčový faktor (Zlato: reálne výnosy, EUR/USD: rozdiel politiky, NQ: politika Fedu) = **bez skóre**.
6. **Istota 0–100** = 30 % pokrytie + 25 % aktuálnosť + 20 % zhoda faktorov + 15 % kvalita zdrojov + 10 % istota režimu. Nie je to pravdepodobnosť zisku.
7. **Režim** (pravidlový, bez LLM): risk-off (VIX ≥ 30 alebo HY OAS z ≥ 2), inflácia (core CPI 3m anualizovane ≥ 3,5 %), spomalenie (nezamestnanosť +0,3 pp za 6 mes.), uvoľňovanie/sprísňovanie (US 2Y − Fed Funds ±0,25 pp), inak zmiešaný. Režim mení znamienko prekvapení z trhu práce pre NQ.
8. **Ochrana pred dvojitým započítaním:** ak všetky dostupné faktory korelovanej skupiny (sadzby/výnosy) ukazujú rovnaký smer, ich príspevky sa násobia 0,85.
9. **Stabilita:** hysteréza ±0,4 okolo hraníc tried (±2,5 a ±6,5). Snapshot do histórie sa ukladá len pri zmene vstupov, takže graf nikdy neobsahuje vymyslené body.

Ilustračný príklad (vymyslené čísla, Zlato): faktory reálne výnosy −4,0 (w 0,30), politika Fedu −2,0 (0,20), USD −3,0 (0,25), prekvapenia +1,0 (0,10), riziko +0,5 (0,15). Príspevky: −1,20, −0,40, −0,75, +0,10, +0,075. Reálne výnosy a politika sú v jednej skupine a obe záporné → ×0,85 (−1,02 a −0,34). Súčet −1,935, pokrytie 1 → skóre **−1,9 = Neutrálne**.

## Dôležité obmedzenia (čítaj pred použitím)

- **Žiadny konsenzus analytikov:** zadarmo a legálne sa nedá získať. „Prekvapenia“ sú **modelové**: odchýlka najnovšej hodnoty od priemeru predchádzajúcich 6 mesiacov (v UI sú tak označené). Nie sú to skutočné prekvapenia voči konsenzu.
- **Fed očakávania** sú proxy (US 2Y − Fed Funds a pohyb 2Y), nie pravdepodobnosti zo sadzobných futures.
- **Eurozóna:** AAA krivka ECB nie je nemecký Bund. Rozdiel výnosov porovnáva len zmeny, lebo konvencie kriviek sa líšia.
- **USD:** Fedov široký index nie je DXY, má oneskorenie a obsahuje EUR (čiastočná cirkularita pre EUR/USD).
- **Safe-haven vplyv rizika na Zlato** a **znamienka prekvapení** sú hypotézy.
- **História nie je point-in-time:** ukladá sa len stopa revízií hodnôt. Spoľahlivý backtest vyžaduje zbieranie vlastných snapshotov (alebo FRED ALFRED vintage dáta), čo MVP nerobí.
- Váhy a prahy sú **neoverené históriou**. Kým nenazbieraš týždne snapshotov a nepozrieš sa na ich vzťah k pohybom, ber skóre ako pomôcku, nie ako edge.
- Chýba: real-time dáta, ceny NQ/GC, LLM vysvetlenia (šablóny sú predvolené), backtest (Fáza 6), Next.js, Eurostat, BLS/BEA priamo.

## Štruktúra

```
src/config.ts         indikátory, váhy, prahy, statický kalendár (jediné miesto s parametrami modelu)
src/stats.ts          medián, MAD, robustné z-skóre
src/scoring/          signals.ts (signály), regime.ts, engine.ts (faktory, pokrytie, istota), explain.ts (slovenské šablóny)
src/providers/        fred.ts, ecb.ts (parsery + volania)
src/http.ts           retry, exponenciálny backoff, rate limit, circuit breaker, redakcia kľúčov
src/db.ts             SQLite schéma (node:sqlite)
src/ingest.ts         načítanie zdrojov, stav poskytovateľov
src/refresh.ts        ingest + prepočet + ukladanie snapshotov
src/server.ts         lokálny HTTP server + plánovač
public/index.html     dashboard
tests/                22 testov; všetky trhové dáta v nich sú SYNTETICKÉ (fixtures.ts)
```

API: `GET /api/bias/current`, `/api/bias/:symbol/history`, `/api/providers/status`, `/api/calendar/upcoming`, `/api/model`, `POST /api/refresh`.

## Prenos do Next.js

Skórovací engine (`src/scoring`, `src/stats.ts`, `src/config.ts`) je čistý TypeScript bez závislostí od frameworku, takže sa dá použiť v Next.js route handleroch bez zmeny.
