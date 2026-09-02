# SEOsilo

Narzędzie do grupowania fraz kluczowych w klastry (silosy) tematyczne dla danej strony -
przydatne przy planowaniu treści i architektury informacji serwisu.

Dwa źródła danych wejściowych:

- **Wklej frazy** - ręcznie wklejona lista fraz (np. z keyword researchu).
- **Podaj URL strony** - podajesz tylko URL strony głównej, a narzędzie samo wykrywa
  istniejące podstrony (przez `sitemap.xml`, a jeśli go brak - przez linki ze strony
  głównej, z poszanowaniem `robots.txt`). Każda podstrona jest analizowana osobno - do
  grupowania trafia tytuł, meta description i nagłówki H1-H3, a nie sam tytuł - i dopiero
  ten bogatszy sygnał treści decyduje o przydziale do klastra. Przydatne, gdy chcesz
  poukładać w silosy treść, która już istnieje na stronie. Bez zewnętrznego API - strona
  jest pobierana bezpośrednio z serwera aplikacji (z zabezpieczeniem przed SSRF: blokadą
  adresów prywatnych/loopback/link-local, ręczną walidacją przekierowań i limitem rozmiaru
  odpowiedzi - zobacz `src/lib/urlSafety.ts`).

Dostępne są trzy metody grupowania:

- **Leksykalna** - działa w pełni offline, bez klucza API. Grupuje na podstawie wspólnych
  znaczących słów (dla wklejonych fraz: podobieństwo Jaccarda; dla treści podstron: mocno
  różniące się długością sygnały wymagają innej metryki - współczynnika nakładania, żeby
  długi zestaw nagłówków nie zaniżał sztucznie podobieństwa do krótszej strony).
- **Embeddingi (szybkie AI)** - wektoryzacja treści przez OpenRouter
  (`openai/text-embedding-3-small` domyślnie) i grupowanie po podobieństwie kosinusowym
  wektorów, tym samym algorytmem UPGMA co metoda leksykalna. Rozumie synonimy i parafrazy
  bez kosztu/czasu pełnego wywołania modelu czatu - jedno wsadowe zapytanie na całe
  grupowanie, z cache'owaniem wektorów per treść. Wymaga klucza `OPENROUTER_API_KEY`.
- **Semantyczna (AI)** - wykorzystuje model Claude (przez OpenRouter) do grupowania po
  znaczeniu i intencji wyszukiwania, z pełnym rozumowaniem o niejednoznacznych przypadkach.
  Najdokładniejsza, ale wolniejsza i droższa przy dużych zbiorach. Wymaga klucza
  `OPENROUTER_API_KEY`.

W trybie „Podaj URL strony" narzędzie dodatkowo:

- **sugeruje linkowanie wewnętrzne** - dla każdego klastra z więcej niż jedną podstroną,
  wg standardowego wzorca silosu: strona główna klastra (fraza główna) linkuje do każdej
  pozostałej podstrony, a każda z nich linkuje z powrotem, z podpowiedzianym tekstem
  anchora (etykieta strony docelowej). Eksport osobnym przyciskiem „Kopiuj sugestie
  linkowania".
- **ostrzega przed kanibalizacją treści** - flaguje pary podstron o bardzo podobnym
  sygnale treści (≥70% wspólnego słownictwa) jako potencjalny duplikat/konkurencję o te
  same zapytania, niezależnie od tego, do jakich klastrów trafiły.

Endpoint API ma limity zapytań (rate limiting) na adres IP - ogólny limit dla wszystkich
żądań oraz dodatkowy, ostrzejszy limit dla trybu `crawl` i metod embeddingi/semantyczna
(wszystkie generują realny koszt: żądania sieciowe do cudzej strony albo płatne wywołanie
API). Limiter działa w pamięci procesu - wystarczający dla wdrożenia na jednej instancji;
przy wielu instancjach każda liczy osobno (`src/lib/rateLimit.ts`).

## Uruchomienie

```bash
npm install
npm run dev
```

Otwórz [http://localhost:3000](http://localhost:3000).

## Konfiguracja grupowania semantycznego (opcjonalnie)

Grupowanie semantyczne przechodzi przez [OpenRouter](https://openrouter.ai/keys)
(API kompatybilne z OpenAI), a nie bezpośrednio przez Anthropic. Skopiuj
`.env.example` do `.env.local` i uzupełnij klucz:

```bash
cp .env.example .env.local
```

```
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-opus-5
OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
EMBEDDING_SIMILARITY_THRESHOLD=0.55
```

`OPENROUTER_MODEL` (domyślnie `anthropic/claude-opus-5`), `OPENROUTER_EMBEDDING_MODEL`
(domyślnie `openai/text-embedding-3-small`) i `EMBEDDING_SIMILARITY_THRESHOLD` (domyślnie
`0.55`) są opcjonalne. Próg podobieństwa dla embeddingów to punkt startowy, nieostrojony na
realnym ruchu - warto go dostroić po pierwszych uruchomieniach na prawdziwych danych.

Bez klucza aplikacja nadal działa - dostępna jest wtedy tylko metoda leksykalna.

## Struktura

- `src/app/page.tsx` - interfejs narzędzia (przełącznik trybu, formularz, wyniki grupowania)
- `src/app/api/cluster/route.ts` - endpoint API (`GET` sprawdza dostępność metod AI,
  `POST` wykonuje grupowanie dla trybu `phrases` lub `crawl`)
- `src/lib/agglomerativeCluster.ts` - wydzielony rdzeń klastrowania UPGMA, współdzielony
  przez metodę leksykalną i embeddingi (różni je tylko funkcja podobieństwa)
- `src/lib/lexicalClustering.ts` - grupowanie leksykalne (offline)
- `src/lib/embeddingClustering.ts` - grupowanie po podobieństwie wektorów embeddingów
  (OpenRouter), z cache'em wektorów per treść
- `src/lib/semanticClustering.ts` - grupowanie semantyczne przez OpenRouter
- `src/lib/siteCrawler.ts` - wykrywanie podstron danej witryny (sitemap.xml / linki,
  z poszanowaniem robots.txt; dla ubogiej nawigacji - jeden dodatkowy poziom linków)
- `src/lib/siloPlanning.ts` - sugestie linkowania wewnętrznego (pillar/spoke) i wykrywanie
  potencjalnej kanibalizacji treści
- `src/lib/htmlParsing.ts` - czyste funkcje parsujące HTML/XML/robots.txt (bez sieci)
- `src/lib/urlSafety.ts` - walidacja URL i bezpieczny fetch (ochrona przed SSRF)
- `src/lib/rateLimit.ts` - limity zapytań na IP (in-memory, per proces)
