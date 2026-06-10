# Bokun — logika wyświetlania cen OTA

## Kanały OTA i waluty

| Prefix | Kanał | Waluta do wyświetlania | Logika |
|--------|-------|------------------------|--------|
| VIA | Viator | PLN | `customerInvoice.total` w EUR → przelicz × kurs NBP |
| GET / GYG | GetYourGuide | PLN | `customerInvoice.total` najczęściej już w PLN |
| KLO | Klook | PLN | jak GYG |
| EXP | Expedia | PLN | jak GYG |
| MUS | Musement | PLN | `customerInvoice.total × 0.75` (netto po prowizji 25%) × kurs NBP |
| HEA | Headout | EUR | `resellerInvoice.total` lub `customerInvoice.total` w EUR |
| TM | TM Direct (Bokun) | EUR | `resellerInvoice.total` lub `customerInvoice.total` w EUR |
| HOT | Hotel (Bokun) | EUR | j.w. |

## Kluczowe zasady

### 1. Musement (MUS) — prowizja 25%

**Problem:** Bokun ustawia `resellerInvoice.total = customerInvoice.total` (cena brutto klienta)
przed rozliczeniem faktury. Pole to NIE jest kwotą netto.

**Rozwiązanie:** Musement zawsze używa wzoru:
```
netEur = customerInvoice.total × 0.75   (25% prowizja Musement)
total  = round(netEur × kurs_EUR_PLN)
```

Wyjątek: jeśli `resellerInvoice.totalSansCommission > 0` (faktura rozliczona),
użyj tej wartości jako `netEur` zamiast `ciTotal × 0.75`.

**Ważne:** W `mapBokunBooking` blok MUS (`codePrefix === 'MUS'`) musi być sprawdzany
**przed** blokiem `riTotal > 0`, bo `riTotal === ciTotal` dla Musement i błędnie
zwróciłoby cenę brutto.

### 2. Viator (VIA) — EUR w customerInvoice

**Problem:** Bokun wysyła `customerInvoice.currency = 'EUR'` dla Viator.

**Rozwiązanie (priorytet):**
1. `totalPriceConverted > 0` → użyj (Bokun już przeliczył)
2. `customerInvoice.currency === 'PLN'` → użyj wprost
3. `customerInvoice.currency === 'EUR'` → przelicz × kurs NBP

### 3. Kurs EUR/PLN

Pobierany z NBP API: `https://api.nbp.pl/api/exchangerates/rates/a/eur/?format=json`
Fallback: `4.25`

W `admin.html` zmienna globalna `_eurPlnRate` ładowana na początku `loadBookings()`.

---

## Gdzie jest logika w kodzie

### `admin.html` — funkcja `mapBokunBooking(item)` (~linia 2180)

Przetwarza live dane z Bokun API przy sync. Kolejność bloków:

```
if (isOtaPln)           → VIA, GET, GYG, KLO, EXP (PLN)
else if (MUS branch)    → MUS zawsze tu (przed riTotal!)
else if (riTotal > 0)   → inne kanały (HEA, TM, HOT) z resellerInvoice
else if (ciTotal > 0)   → fallback na customerInvoice
else                    → totalPrice
```

### `admin.html` — ładowanie DB (~linia 2270)

Bookings z Supabase. Dla MUS bookingów gdzie `bokun_confirmation_code IS NULL`:
- `codeP = ''` → nie trafia do `otaPlnPrefixes`
- wykrywanie przez `source === 'Musement'` lub `id` zaczynające się od `MUS-`
- jeśli `currency = 'EUR'`: stosuje `× 0.75 × kurs`

### `admin.html` — sync z Bokun API (~linia 2342)

**found in bokunCodeIndex:** aktualizuje `allBookings[idx]` — jeśli mapped total jest EUR
a kanał OTA (MUS etc.), konwertuje EUR→PLN.

**nowy wpis (not in seenIds):** safety net — jeśli kanał OTA a currency != PLN, konwertuj.

### `edge-functions/bokun-webhook.ts` — zapis do Supabase

Ta sama logika co `mapBokunBooking`, ale asynchronicznie (pobiera kurs z NBP).
MUS block musi być przed riTotal block — ta sama zasada.

---

## Historia problemów (2026-06-10)

| Objaw | Przyczyna | Fix |
|-------|-----------|-----|
| 273 zł zamiast 1157 zł dla Viator | `customerInvoice` w EUR, kod zakładał PLN | sprawdź walutę + przelicz NBP |
| 654 zł zamiast 490 zł dla Musement | `riTotal === ciTotal` (gross), blok MUS był po riTotal | przenieś blok MUS przed riTotal |
| Strona logowania bez CSS | CSP blokowała `cdn.tailwindcss.com` | dodano do script-src/style-src |
| Supabase WebSocket zablokowany | CSP nie miała `wss://*.supabase.co` | dodano do connect-src |
