# AUDIT.md — Thousand Miles Panel
**Data:** 26 lipca 2026 | **Zakres:** admin.html, index.html, supabase/functions/ | **Wersja audytu:** 2.0

---

## 1. Podsumowanie wykonawcze

Panel Thousand Miles to funkcjonalna, działająca produkcyjnie aplikacja obsługująca rezerwacje wycieczek dla hoteli partnerskich. Architektura jest prosta i adekwatna do obecnej skali — statyczny HTML + Supabase + Edge Functions. Bezpieczeństwo podstawowe (JWT, RLS, weryfikacja podpisów webhook) jest na miejscu. Jednak aplikacja ma kilka poważnych błędów logiki biznesowej i bezpieczeństwa, które wymagają natychmiastowej naprawy, zanim system zostanie obciążony większą liczbą rezerwacji lub partnerów.

**3 mocne strony:**
1. Weryfikacja podpisów webhook (Stripe HMAC SHA-256 z ochroną przed replay ±5 min, Bokun HMAC SHA-1) — zaimplementowane poprawnie.
2. Security headers w Vercel (HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) — wzorowa konfiguracja.
3. Autoryzacja w edge functions — każda sprawdza JWT, rolę admina lub partnera, z poprawnym wzorcem email-based lookup w `admin_users`.

**3 największe ryzyka:**
1. **Partner hotelowy może zapłacić za rezerwację dowolną kwotę** — cena Stripe dla nowej rezerwacji pochodzi z ciała żądania HTTP, nie jest weryfikowana server-side (`create-stripe-session/index.ts:46`).
2. **XSS w 3 miejscach panelu partnerów** — dane z Bokun API i bazy wstawiane do DOM przez `innerHTML` bez escapowania (`index.html:2131`, `index.html:~1700`, `create-stripe-session:100`).
3. **Anulowanie rezerwacji nie zwalnia miejsca w Bokun** — funkcje `check-pending-bookings` i `stripe-webhook` (obsługa wygasłej sesji) ustawiają status `cancelled` w DB, ale nie wywołują Bokun cancel API — slot pozostaje zajęty przez wiele godzin.

---

## 2. Tabela ocen

| Obszar | Ocena | Uzasadnienie |
|---|:---:|---|
| Architektura i struktura | 4/10 | Dwa monolityczne pliki 8600+/4500 linii; brak separacji warstw; duplikacja kodu w 5 edge functions |
| Poprawność działania | 5/10 | Główne ścieżki działają, ale: rollback Bokun brakuje, checkoutOption hardcoded, Stripe failure zostawia "zombie" booking |
| Jakość kodu | 4/10 | Bardzo długie funkcje, 39 console.log w produkcji, magiczne stałe, duplikacja logiki |
| Bezpieczeństwo | 5/10 | Dobre podstawy (JWT, podpisy webhook), ale manipulacja ceną Stripe i XSS w 3 miejscach są krytyczne |
| Wydajność | 5/10 | select('*') + limit(50000), Tailwind CDN Play (runtime), Realtime channels bez cleanup |
| UX i interfejs | 4/10 | 12+ alert() zamiast toastów, surowe błędy Supabase widoczne dla użytkownika, brak stanów błędów |
| Dostępność (a11y) | 2/10 | 0 atrybutów ARIA, klikalne divy, 130 labelek bez powiązania for/id, brak focus styles |
| Responsywność i mobile | 3/10 | Panel desktop-only, sidebar stały 240px, brak hamburger menu, 15 breakpointów w 8600 linii |
| Odporność na awarie | 4/10 | Brak rollbacku Bokun, catch() połykające błędy bez powiadomienia UI, loadBookings bez try/catch |
| Testy | 1/10 | Brak jakichkolwiek testów (unit, integration, e2e) |
| Zależności i konfiguracja | 3/10 | Brak package.json, Tailwind CDN Play w produkcji, brak .env.example, brak SRI |
| Gotowość do wdrożenia | 6/10 | Build działa, Vercel headers wzorowe, ale brak CI/CD i source maps są eksponowane |
| Dokumentacja | 1/10 | README ma 2 linie — nowa osoba nie jest w stanie uruchomić projektu |

---

## 3. Lista problemów

---

### 🔴 KRYTYCZNE

---

**[K-01] Manipulacja ceną Stripe — partner może zapłacić dowolną kwotę**
- **Plik:** `supabase/functions/create-stripe-session/index.ts:46–48`
- **Problem:** Przy tworzeniu nowej rezerwacji z linkiem płatniczym, serwer odpada do kwoty podanej przez klienta (`clientAmountPln`) jeśli booking nie istnieje jeszcze w DB. Partner hotelowy z DevTools może wysłać request z `amount_pln: 1` i wygenerować sesję Stripe na 1 zł zamiast 499 zł. Rezerwacja zostanie oznaczona jako `paid` po zapłacie 1 zł.
- **Skutek:** Bezpośrednia strata finansowa. Każdy zautentykowany partner może zarezerwować dowolną wycieczkę za 1 zł.
- **Naprawa:** Przed wywołaniem Stripe:
  1. Wstaw booking do DB z `status: 'payment_pending'`
  2. Pobierz cenę server-side: `db.from('tour_commissions').select('price_pln').eq('tour_title', tour_name).eq('partner_id', partnerRow.id).single()`
  3. Użyj tej ceny jako `amount_pln` — całkowicie ignorując `clientAmountPln`

---

**[K-02] checkoutOption hardcoded — błąd przy wycieczkach bez pełnej płatności Bokun**
- **Plik:** `index.html:3147`
- **Problem:** Zmienna `checkoutOptionType` jest poprawnie obliczana (linia 3119), ale do payloadu Bokun zawsze trafia hardcoded string `'CUSTOMER_FULL_PAYMENT'`. Dla wycieczek gdzie Bokun obsługuje tylko `CUSTOMER_NO_PAYMENT`, Bokun może odrzucić rezerwację lub stworzyć błędny rekord.
- **Skutek:** Rezerwacja może nie trafić do Bokun mimo "sukcesu" w UI.
- **Naprawa:** Zmienić linię 3147 z `checkoutOption: 'CUSTOMER_FULL_PAYMENT'` na `checkoutOption: checkoutOptionType`.

---

**[K-03] Anulowanie payment_pending nie zwalnia miejsca w Bokun**
- **Plik:** `supabase/functions/check-pending-bookings/index.ts:36–40`
- **Problem:** Funkcja fallback-cleanup anuluje `payment_pending` bookings w DB po 35 minutach, ale nie wywołuje Bokun cancel API. Rezerwacja Bokun pozostaje w stanie `reserved` przez wiele godzin (Bokun timeout to nie 35 min). Slot jest zablokowany dla innych gości.
- **Skutek:** "Martwe" rezerwacje blokują dostępność wycieczki. Goście widzą "brak miejsc" dla dat, które faktycznie są wolne.
- **Naprawa:** Przed `update`, pobrać `bokun_confirmation_code` i wywołać Bokun cancel API (analogicznie jak w `cancel-booking/index.ts:37–50`). Uwaga: upewnić się, że Bokun rzeczywiście nie anuluje automatycznie po 30 min — zweryfikować w docs Bokun.

---

**[K-04] Wygaśnięcie sesji Stripe nie zwalnia miejsca w Bokun**
- **Plik:** `supabase/functions/stripe-webhook/index.ts:208–223`
- **Problem:** Identyczny jak K-03, ale dla ścieżki `checkout.session.expired`. Webhook Stripe poprawnie ustawia `cancelled` w DB, ale nie wywołuje Bokun cancel API.
- **Skutek:** Jak wyżej — slot zablokowany mimo anulowania.
- **Naprawa:** W handlerze `checkout.session.expired` dodać wywołanie Bokun cancel API dla `existing.bokun_confirmation_code` (już dostępny w zapytaniu na linii 214).

---

### 🟠 WYSOKIE

---

**[W-01] XSS: innerHTML z danymi z Bokun API**
- **Plik:** `index.html:2131`
- **Problem:** `descEl.innerHTML = p.description` — opis wycieczki pobierany z Bokun API jest wstawiany bezpośrednio do DOM bez escapowania. Bokun może zwrócić HTML z atrybutami event handlers (np. `<img onerror="...">`).
- **Skutek:** XSS — złośliwy kod może wykraść tokeny JWT partnerów hotelowych.
- **Naprawa:** `descEl.textContent = p.description` lub `descEl.innerHTML = escapeHtml(p.description)`.

---

**[W-02] XSS: b.email w innerHTML listy rezerwacji**
- **Plik:** `index.html:~1690–1708` (funkcja renderująca listę rezerwacji)
- **Problem:** Email gościa z bazy danych wstawiany przez `innerHTML` bez escapowania.
- **Skutek:** Jeśli email zawiera HTML (np. `"><img onerror="alert(1)">`), partner widzi XSS przy ładowaniu listy bookingów.
- **Naprawa:** Zastąpić `innerHTML` użyciem `escapeHtml()` lub `textContent`.

---

**[W-03] HTML injection w emailu do gościa**
- **Plik:** `supabase/functions/create-stripe-session/index.ts:100–120`
- **Problem:** Pola `guest_name`, `tour_name`, `date` wstawiane do szablonu HTML emaila bez escapowania. Te wartości pochodzą z frontendu (ciało żądania HTTP).
- **Skutek:** Złośliwy partner może wysłać gościowi email z wstrzykniętym HTML (np. fałszywa strona logowania).
- **Naprawa:** Owinąć każdą zmienną funkcją `escapeHtml()` (jest już zdefiniowana w `stripe-webhook/index.ts:43` — przenieść do shared module).

---

**[W-04] Timing attack na HMAC webhook**
- **Plik:** `supabase/functions/stripe-webhook/index.ts:40`, `supabase/functions/bokun-webhook/index.ts:29`
- **Problem:** Weryfikacja podpisu HMAC używa `s === expected` (porównanie stringów). JavaScript `===` przerywa porównanie przy pierwszym różnym znaku — atakujący może statystycznie ustalić poprawną sygnaturę przez timing attack.
- **Skutek:** Teoretyczne ominięcie weryfikacji podpisu. Ryzyko praktyczne niskie w środowisku cloud (latencja sieciowa maskuje różnicę czasową), ale narusza dobre praktyki kryptograficzne.
- **Naprawa:** Użyć `crypto.subtle.timingSafeEqual()` lub własnej implementacji constant-time comparison.

---

**[W-05] Stripe failure tworzy "zombie" booking bez URL płatności**
- **Plik:** `index.html:3234–3248`
- **Problem:** Jeśli Stripe API zawiedzie po rezerwacji Bokun, booking trafia do DB ze statusem `payment_pending` i `stripe_session_url: null`. Gość nie dostaje emaila z linkiem. Rezerwacja Bokun istnieje i blokuje slot.
- **Skutek:** "Zombie" booking — zajęte miejsce Bokun, brak możliwości zapłaty, partner musi ręcznie naprawiać.
- **Naprawa:** Gdy Stripe zawiedzie przy nowej rezerwacji: anulować Bokun, NIE zapisywać bookingu do DB, pokazać błąd partnerowi.

---

**[W-06] Brak rollbacku Bokun gdy DB INSERT zawiedzie**
- **Plik:** `index.html:3259–3308`
- **Problem:** Jeśli Supabase INSERT zwróci błąd po pomyślnej rezerwacji w Bokun, booking nie istnieje w DB ale Bokun ma zajęty slot. Nowy UI-booking tego gościa stworzy duplikat w Bokun.
- **Skutek:** Phantom bookings w Bokun, zduplikowane sloty, trudna ręczna korekta.
- **Naprawa:** W bloku `catch` po nieudanym INSERT wywołać Bokun cancel API i poinformować partnera o pełnym błędzie.

---

**[W-07] cancel-booking nie sprawdza błędu DB update**
- **Plik:** `supabase/functions/cancel-booking/index.ts:165`
- **Problem:** `await db.from('bookings').update({status: 'cancelled'}).eq('id', booking_id)` — wynik operacji nie jest sprawdzany. Jeśli update się nie powiedzie, booking zostaje w statusie `cancelling` na zawsze. Kolejna próba anulowania zwraca 409.
- **Skutek:** Booking "zamrożony" w `cancelling` — ani aktywny, ani anulowany. Partner i admin nie mogą nic zrobić przez UI.
- **Naprawa:** `const { error } = await db.from('bookings').update(...)` → jeśli `error`, zwrócić HTTP 500 i zalogować.

---

**[W-08] Realtime channels bez cleanup — wycieki subskrypcji**
- **Plik:** `index.html:1565–1582`
- **Problem:** `db.channel('partner-bookings-watch').subscribe()` — brak `db.removeChannel()` gdziekolwiek. Jeśli `initPartnerDashboard()` jest wywoływane ponownie (np. po Realtime UPDATE), tworzone są duplikaty subskrypcji. Każda zmiana w tabeli `bookings` wyzwala N callbacków (gdzie N = liczba wywołań init).
- **Skutek:** Wielokrotne fetche przy każdej zmianie, rosnące zużycie pamięci, nieprzewidywalne zachowanie UI.
- **Naprawa:** Przed `db.channel(...)` wywołać `await db.removeAllChannels()`.

---

**[W-09] loadBookings() bez try/catch — cicha awaria**
- **Plik:** `admin.html:2654`
- **Problem:** Główna funkcja pobierania rezerwacji nie ma żadnej obsługi błędu. Przy błędzie sieci lub Supabase 500, admin widzi pustą tabelę bez żadnego komunikatu.
- **Skutek:** Admin myśli że "nie ma rezerwacji" zamiast "wystąpił błąd". Ryzyko przeoczenia problemu produkcyjnego.
- **Naprawa:** Owinąć w `try/catch`, przy błędzie wyświetlić komunikat w miejscu tabeli: `showToast('Błąd pobierania rezerwacji. Odśwież stronę.', 'error')`.

---

**[W-10] alert() zamiast toast — 12+ miejsc w admin.html**
- **Plik:** `admin.html:2973, 3311, 3337, 3507, 3517, 3599, 3810, 3840, 3867, 4567` i inne
- **Problem:** Błędy walidacji i systemowe wyświetlane przez `alert()` — modal systemowy blokujący JS, niemożliwy do ostylowania. `showToast()` istnieje i działa (linia 5633).
- **Skutek:** Zły UX dla każdego pracownika TM. `alert()` wygląda jak błąd przeglądarki, nie część aplikacji.
- **Naprawa:** Globalne search-replace `alert('...`)` → `showToast('...', 'error')`. 30 minut pracy.

---

**[W-11] Surowe błędy Supabase pokazywane pracownikom**
- **Plik:** `admin.html:3337, 3517, 4567`
- **Problem:** `alert('Error: ' + error.message)` — techniczne komunikaty Supabase (np. `new row violates row-level security policy`) trafiają bezpośrednio do UI.
- **Skutek:** Niezrozumiałe dla pracownika; ujawnia wewnętrzną strukturę DB.
- **Naprawa:** Catch błąd → `console.error('[debug]', error)` → `showToast('Wystąpił błąd. Spróbuj ponownie lub skontaktuj się z administratorem.', 'error')`.

---

**[W-12] select('*') bez limitu na całą historię rezerwacji partnera**
- **Plik:** `index.html:1615–1617`
- **Problem:** `db.from('bookings').select('*').eq('partner_id', ...).order(...)` bez `.limit()`. Hotel z 2000+ rezerwacjami pobierze wszystkie dane (w tym notatki, dodatkowych gości, URL Stripe) przy każdym załadowaniu strony.
- **Skutek:** Wolne ładowanie, duże zużycie transferu, ryzyko timeout przy dużej skali.
- **Naprawa:** Dodać `.limit(50).range(offset, offset+49)` z infinite scroll lub paginacją. Realtime trigger aktualizować tylko zmieniony rekord, nie robić full reload.

---

**[W-13] 0 atrybutów ARIA w całym admin.html**
- **Plik:** `admin.html` (cały plik, 8625 linii)
- **Problem:** Grep `aria-|role=` zwrócił 0 wyników. Panel ma modale, taby, toasty, dynamiczne listy — żaden nie ma atrybutów dostępności.
- **Skutek:** Panel niedostępny dla osób z niepełnosprawnościami i asystentami głosowymi.
- **Naprawa (minimum):**
  - Modale: `role="dialog" aria-modal="true" aria-labelledby="modal-title"`
  - Toasty: `role="alert" aria-live="polite"`
  - Aktywna sekcja sidebar: `aria-current="page"`

---

**[W-14] Klikalne `<div>` zamiast `<button>` — niedostępne klawiaturowo**
- **Plik:** `admin.html:5028, 7439, 7556, 7559` i inne
- **Problem:**
  ```html
  <div onclick="selectTour(this.dataset.tour)" class="cursor-pointer ...">
  <div onclick="abOpenTour(${t.idx})" class="cursor-pointer ...">
  ```
  Divy nie są focusowalne przez Tab, nie obsługują Enter/Space, screen readery nie czytają ich jako interaktywnych.
- **Naprawa:** Zamienić na `<button type="button">` lub dodać `tabindex="0" role="button" onkeydown="if(event.key==='Enter'||event.key===' ') this.onclick()"`.

---

**[W-15] 130 labelek bez powiązania for/id z polem formularza**
- **Plik:** `admin.html` (całościowo)
- **Problem:** 130 elementów `<label>` w pliku, ale tylko 4 mają atrybut `for` powiązany z `id` pola. Kliknięcie etykiety nie fokusuje pola — standardowe zachowanie przeglądarki jest złamane.
- **Naprawa:** Dla każdego `<label>Text</label><input ...>`, dodać `for="field-id"` na label i `id="field-id"` na input.

---

**[W-16] email_blocks wstawiane do HTML emaila bez escapowania**
- **Plik:** `supabase/functions/stripe-webhook/index.ts:181`, `supabase/functions/send-booking-confirmation/index.ts:52`
- **Problem:** `tourEmailBlocks.map(b => `...${b.name}...${b.info}...`)` — dane z `tour_config.email_blocks` (edytowane przez admina) bez escapowania w HTML emaila do gości.
- **Skutek:** Błąd admina lub atak na DB może spowodować HTML injection w emailach wysyłanych do tysięcy gości.
- **Naprawa:** Owinąć `b.name` i `b.info` w `escapeHtml()` (zdefiniowane w `stripe-webhook/index.ts:43`).

---

### 🟡 ŚREDNIE

---

**[S-01] CSP zawiera `unsafe-inline` — XSS protection osłabiona**
- **Plik:** `vercel.json`
- **Problem:** `Content-Security-Policy` zawiera `'unsafe-inline'` w `script-src`. To konieczne ze względu na inline JS w HTML, ale jednocześnie unieważnia ochronę CSP przed XSS.
- **Naprawa (długoterminowo):** Wydzielić JS do osobnych plików, wtedy usunąć `unsafe-inline`.

---

**[S-02] CORS `*` na endpointach webhook**
- **Plik:** `stripe-webhook/index.ts:3`, `bokun-webhook/index.ts:3`
- **Problem:** 9 z 11 edge functions ma `'Access-Control-Allow-Origin': 'https://panel.thousandmiles.pl'`. Tylko webhook endpoints mają `'*'`. Choć webhooks są server-to-server i ochrona przez HMAC jest na miejscu, wildcard CORS jest sprzeczny z resztą konfiguracji.
- **Naprawa:** Zmienić na `'https://panel.thousandmiles.pl'` — Stripe i Bokun nie wysyłają CORS preflight.

---

**[S-03] MFA trust 30 dni w localStorage**
- **Plik:** `admin.html` (sekcja MFA)
- **Problem:** Flaga "zaufane urządzenie" przechowywana w `localStorage` przez 30 dni. XSS na panelu pozwoliłby atakującemu pominąć MFA przez manipulację `localStorage`.
- **Naprawa:** Przechowywać trust token w `httpOnly` cookie lub jako hash server-side powiązany z sesją.

---

**[S-04] Hardcoded lista adminów w edge functions — desynchronizacja z DB**
- **Plik:** `supabase/functions/create-partner/index.ts:8–13`, `delete-partner/index.ts:25`
- **Problem:** Dwie równoległe ścieżki autoryzacji: hardcoded `ADMIN_EMAILS` i tabela `admin_users`. Dodanie nowego admina w DB nie wystarczy — trzeba też edytować kod.
- **Naprawa:** Usunąć `ADMIN_EMAILS`, oprzeć się wyłącznie na tabeli `admin_users` (pattern już stosowany w innych funkcjach).

---

**[S-05] Brak SRI dla zewnętrznych bibliotek CDN**
- **Plik:** `admin.html:8–12`
- **Problem:** Supabase-js, Chart.js, ExcelJS, Font Awesome ładowane z CDN bez `integrity="sha384-..."`. Kompromitacja jsdelivr.net lub cdnjs wstrzykuje złośliwy JS do panelu admina.
- **Naprawa:** Dodać `integrity` i `crossorigin="anonymous"` dla każdego zasobu CDN. Hash: `curl -s URL | openssl dgst -sha384 -binary | openssl base64 -A`.

---

**[S-06] Debug mode `signatureTest` aktywny na produkcji**
- **Plik:** `supabase/functions/bokun-sync/index.ts:89`
- **Problem:** Każdy admin może wywołać endpoint z `{signatureTest: true}` i wygenerować 15 requestów do Bokun API. Narzędzie z okresu development nieusunięte z produkcji.
- **Naprawa:** Usunąć cały blok `if (body.signatureTest)`.

---

**[S-07] Tailwind CDN Play w index.html — nieprodukcyjny tryb**
- **Plik:** `index.html:7`
- **Problem:** `<script src="https://cdn.tailwindcss.com">` — tryb "Play CDN" generuje CSS runtime (~500 KB JS). Nie jest przeznaczony dla produkcji (oficjalna dokumentacja Tailwind). Wolniejszy, brak tree-shakingu, może różnić się od kompilowanej wersji. admin.html poprawnie używa skompilowanego `assets/admin.css`.
- **Naprawa:** Zbudować `assets/partner.css` analogicznie jak `admin.css`: `npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o assets/partner.css --minify`.

---

**[S-08] Brak package.json i tailwind.config.js w repozytorium**
- **Plik:** root
- **Problem:** Projekt nie ma `package.json`. Tailwind config musi istnieć lokalnie, ale nie jest w repo. Nowy developer nie może zbuildować projektu.
- **Naprawa:** Dodać `package.json` z `devDependencies` i scriptem `build:css`. Dodać `tailwind.config.js` do repo.

---

**[S-09] Stany błędów brakujące w widgetach dashboardu**
- **Plik:** `admin.html:466, 482, 490`
- **Problem:** Widgety "Today's departures", "Partner leaderboard", "Silent partners" pokazują "Loading..." ale nie mają stanu błędu. Przy błędzie API "Loading..." pozostaje na zawsze.
- **Naprawa:** Dodać `catch` z komunikatem w każdym widgecie.

---

**[S-10] Niespójny język interfejsu — mix polskiego i angielskiego**
- **Plik:** `admin.html:4218, 4222, 4533` i inne
- **Problem:** UI generalnie po angielsku, ale kilka toastów i confirm dialogów po polsku (`"Oznaczono jako No Show"`, `"Oznaczono jako Paid ✓"`). Brak decyzji o jednym języku.
- **Naprawa:** Wybrać jeden język (angielski dla spójności z Supabase, Bokun i Stripe) i ujednolicić wszystkie komunikaty.

---

**[S-11] XSS: b.time i b.bokun_confirmation_code bez escapowania**
- **Plik:** `index.html:1762, 1884`
- **Problem:** Pola `time` i `bokun_confirmation_code` z DB wstawiane do innerHTML bez `escapeHtml()`. Ryzyko niskie (Bokun zwraca alfanumeryki), ale narusza defensywny wzorzec.
- **Naprawa:** Używać `escapeHtml()` dla wszystkich danych z zewnętrznych źródeł.

---

**[S-12] Idempotency webhook Stripe nie jest atomowa**
- **Plik:** `supabase/functions/stripe-webhook/index.ts:121–123`
- **Problem:** Read-then-write bez transakcji: `SELECT status` → if paid, skip. Przy równoległych retries Stripe możliwy double-update.
- **Naprawa:** `db.from('bookings').update({status: 'paid'}).eq('id', bookingId).eq('status', 'payment_pending')` — atomic update z warunkiem.

---

**[S-13] Brak cron job dla check-pending-bookings — funkcja nigdy nie jest wywoływana automatycznie**
- **Plik:** `supabase/functions/check-pending-bookings/index.ts`
- **Problem:** Funkcja jest chroniona autentykacją admina i musi być wywoływana ręcznie. Jako fallback-cleanup (35-min cutoff) nie działa automatycznie.
- **Naprawa:** Skonfigurować Supabase Cron (pg_cron) lub zewnętrzny scheduler (Vercel Cron) do wywoływania funkcji co 10 minut.

---

### 🟢 NISKIE

---

**[N-01] Brak AbortController w callach do Bokun (race condition w kalendarzu)**
- **Plik:** `admin.html` (funkcje `abLoadAvailability`, `mbLoadAvailability`)
- **Problem:** Szybkie kliknięcia w kalendarzu wysyłają wiele requestów do Bokun API. Odpowiedzi wracają w losowej kolejności — ostatnia "wygrywa". Może wyświetlić dostępność z innego miesiąca.
- **Naprawa:** Implementować `AbortController` — przy nowym kliknięciu abort poprzedniego requesta.

---

**[N-02] 39 console.log/error/warn w kodzie produkcyjnym**
- **Plik:** `admin.html` (18), `index.html` (21)
- **Problem:** Logowanie do konsoli przeglądarki widoczne dla każdego z DevTools. Ujawnia przepływ danych i wewnętrzną strukturę.
- **Naprawa:** Usunąć `console.log` z UI. W edge functions — zachować `console.error` (trafiają do Supabase logs, nie do przeglądarki).

---

**[N-03] SQL migracje w katalogu głównym**
- **Plik:** `migration_edit_booking.sql`, `supabase_migration.sql` i inne w `/`
- **Problem:** Niesortowane pliki SQL w root projektu. Niejasne które są aktualne.
- **Naprawa:** Przenieść do `supabase/migrations/` z timestampowanymi nazwami (`20260726_add_package_lines.sql`).

---

**[N-04] Duplikacja bokunDate() i hmac() w 5 edge functions**
- **Plik:** `bokun-sync`, `bokun-webhook`, `cancel-booking`, `stripe-webhook`, `bokun-pickup-places`
- **Problem:** Identyczne funkcje kopiowane między plikami. Zmiana logiki wymaga edycji 5 plików.
- **Naprawa:** Stworzyć `supabase/functions/_shared/bokun.ts` z eksportowanymi utilities.

---

**[N-05] README.md nieużyteczny**
- **Plik:** `README.md`
- **Problem:** Dwie linie tekstu. Nowa osoba techniczna nie jest w stanie uruchomić projektu.
- **Naprawa:** Dodać sekcje: Requirements, Setup, Environment Variables, Build CSS, Deploy edge functions, DB migrations, Architecture overview.

---

**[N-06] Brak .env.example**
- **Plik:** root
- **Naprawa:** Stworzyć `.env.example` z listą wymaganych kluczy: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `BOKUN_ACCESS_KEY`, `BOKUN_SECRET_KEY`, `BOKUN_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`.

---

**[N-07] 7 obrazków bez atrybutu alt**
- **Plik:** `admin.html:1380, 1558, 2234, 4660, 5596, 6468, 7435`
- **Naprawa:** Dodać `alt=""` (dekoracyjne) lub opisowy tekst.

---

**[N-08] 218 inline styles zamiast klas Tailwind**
- **Plik:** `admin.html` (całościowo)
- **Problem:** `style="background:#E8751A"` zamiast klasy `bg-brand`. Utrudnia globalną zmianę kolorystyki.
- **Naprawa:** Stopniowo zastępować stałymi Tailwind.

---

**[N-09] Magiczne stałe bez nazw**
- **Plik:** `admin.html:2658` (`limit(50000)`), `admin.html:2673` (`new Date('2026-01-01')`), `create-stripe-session/index.ts:65` (`30 * 60`)
- **Naprawa:** `const MAX_BOOKINGS_FETCH = 5000`, `const PAYMENT_LINK_TTL_SECONDS = 30 * 60`.

---

**[N-10] select('*') zamiast named columns w edge functions**
- **Plik:** `index.html:2000, 2003`, `admin.html:2658`
- **Problem:** Pobieranie wszystkich kolumn gdzie potrzeba tylko kilku — zbędny transfer danych, ujawnia schemat DB.
- **Naprawa:** Wylistować potrzebne kolumny: `.select('id, title, active, photo_url, email_blocks')`.

---

## 4. Szybkie wygrane (max 30 min każda)

| # | Akcja | Plik | Czas | Efekt |
|---|---|---|:---:|---|
| 1 | Zamień wszystkie `alert()` na `showToast()` | admin.html | 30 min | Natychmiastowa poprawa UX dla całego zespołu |
| 2 | Dodaj `escapeHtml()` dla `p.description` | index.html:2131 | 5 min | Zamknięcie XSS z Bokun API |
| 3 | Dodaj `.eq('status', 'payment_pending')` w stripe-webhook update | stripe-webhook:128 | 10 min | Atomic idempotency — bez transakcji |
| 4 | Zmień `checkoutOption: 'CUSTOMER_FULL_PAYMENT'` na `checkoutOption: checkoutOptionType` | index.html:3147 | 5 min | Naprawia logikę Bokun dla niektórych wycieczek |
| 5 | Dodaj `await db.removeAllChannels()` przed `db.channel()` | index.html:1565 | 10 min | Eliminuje wyciek Realtime subskrypcji |
| 6 | CORS webhooks: zmień `'*'` na `'https://panel.thousandmiles.pl'` | stripe-webhook:3, bokun-webhook:3 | 5 min | Spójna konfiguracja CORS |
| 7 | Usuń blok `if (body.signatureTest)` | bokun-sync:89 | 5 min | Usuwa debug code z produkcji |
| 8 | Dodaj `.limit(100)` do loadPartnerBookings | index.html:1617 | 5 min | Natychmiastowe przyspieszenie dla rosnącej bazy bookingów |
| 9 | Dodaj `role="dialog" aria-modal="true"` do modali | admin.html | 20 min | Podstawowa dostępność bez refaktoru |
| 10 | Stwórz `.env.example` z listą kluczy | root | 10 min | Onboarding nowej osoby możliwy |

---

## 5. Plan działania — TOP 10

Kolejność według: wpływ na bezpieczeństwo finansowe → poprawność działania → UX → dług techniczny.

| # | Zadanie | Priorytet | Szacunek |
|---|---|:---:|:---:|
| 1 | **[K-01] Walidacja ceny Stripe server-side** — pobierać z `tour_commissions` zamiast ufać `clientAmountPln` | 🔴 | 2–4h |
| 2 | **[W-01, W-02] XSS — innerHTML z danymi zewnętrznymi** — `p.description`, `b.email`, plus wszystkie pozostałe pola bez `escapeHtml()` | 🟠 | 2h |
| 3 | **[W-03] HTML injection w emailach** — escapować `guest_name`, `tour_name`, `date`, `email_blocks` w szablonach Resend | 🟠 | 1h |
| 4 | **[K-03, K-04] Bokun cancel przy automatycznym anulowaniu** — `check-pending-bookings` i `stripe-webhook.expired` muszą wywołać Bokun cancel API | 🔴 | 2–3h |
| 5 | **[W-05, W-06] Rollback przy błędach** — gdy Stripe lub DB INSERT zawiedzie, wycofać Bokun; gdy Stripe zawiedzie, nie zapisywać bookingu do DB | 🟠 | 3–4h |
| 6 | **[W-10, W-11] alert() → toast + ogólne komunikaty błędów** — search-replace 12+ wywołań, zastąpić surowe błędy Supabase ogólnymi komunikatami | 🟠 | 30 min |
| 7 | **[K-02] checkoutOption hardcoded** — użyć `checkoutOptionType` z obliczonej zmiennej | 🔴 | 5 min |
| 8 | **[W-08] Realtime channel cleanup** — `db.removeAllChannels()` przed ponowną subskrypcją | 🟠 | 10 min |
| 9 | **[S-07] Tailwind CDN Play → skompilowany CSS** — zbudować `assets/partner.css` i zastąpić CDN Play w index.html | 🟡 | 1h |
| 10 | **[S-04, N-01] Konsolidacja autoryzacji adminów** — usunąć `ADMIN_EMAILS`, oprzeć wyłącznie na `admin_users`; dodać cron do `check-pending-bookings` | 🟡 | 2h |

---

## Co działa dobrze — nie ruszać

- **Weryfikacja podpisów webhook** — Stripe HMAC SHA-256 z replay attack protection (±5 min), Bokun HMAC SHA-1 — poprawnie zaimplementowane.
- **Security headers w Vercel** — HSTS (2 lata, preload), X-Frame-Options: DENY, nosniff, Referrer-Policy, Permissions-Policy — wzorowa konfiguracja.
- **Autoryzacja JWT w edge functions** — każda sprawdza `getUser()`, potem rolę przez `admin_users` lub `partners` (poprawny wzorzec email-based lookup).
- **Atomic lock przy anulowaniu** — status `cancelling` przed refundem Stripe zapobiega race condition.
- **escapeHtml() zdefiniowane** — funkcja istnieje w obu front-endach i w edge functions; problem to niekonsekwentne użycie, nie brak narzędzia.
- **Supabase anon key** — klucz publiczny, RLS chroni dostęp do danych — poprawny pattern.
- **Obsługa MFA** — dwuetapowa weryfikacja admina działa; problem tylko z localStorage storage.
- **Błędy Bokun traktowane nieblokująco** — przy błędzie potwierdzenia Bokun webhook zwraca 200 (Stripe nie retryuje) i loguje — poprawna decyzja.
- **Idempotencja webhooków** — check `existing.status === 'paid'` przed update istnieje (problem tylko z atomic-ością).
- **Migracje DB** — `package_lines`, kolumny bezpieczeństwa dodane poprawnie.
