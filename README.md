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

Dostępne są dwie metody grupowania:

- **Leksykalna** - działa w pełni offline, bez klucza API. Grupuje na podstawie wspólnych
  znaczących słów (dla wklejonych fraz: podobieństwo Jaccarda; dla treści podstron: mocno
  różniące się długością sygnały wymagają innej metryki - współczynnika nakładania, żeby
  długi zestaw nagłówków nie zaniżał sztucznie podobieństwa do krótszej strony).
- **Semantyczna (AI)** - wykorzystuje model Claude (przez OpenRouter) do grupowania po
  znaczeniu i intencji wyszukiwania, nie tylko wspólnych słowach. Wymaga klucza
  `OPENROUTER_API_KEY`.

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
```

`OPENROUTER_MODEL` jest opcjonalny (domyślnie `anthropic/claude-opus-5`) - można
podać dowolny slug modelu dostępny na OpenRouter, np. `anthropic/claude-sonnet-5`.

Bez klucza aplikacja nadal działa - dostępna jest wtedy tylko metoda leksykalna.

## Struktura

- `src/app/page.tsx` - interfejs narzędzia (przełącznik trybu, formularz, wyniki grupowania)
- `src/app/api/cluster/route.ts` - endpoint API (`GET` sprawdza dostępność metody
  semantycznej, `POST` wykonuje grupowanie dla trybu `phrases` lub `crawl`)
- `src/lib/lexicalClustering.ts` - grupowanie leksykalne (offline)
- `src/lib/semanticClustering.ts` - grupowanie semantyczne przez OpenRouter
- `src/lib/siteCrawler.ts` - wykrywanie podstron danej witryny (sitemap.xml / linki,
  z poszanowaniem robots.txt)
- `src/lib/htmlParsing.ts` - czyste funkcje parsujące HTML/XML/robots.txt (bez sieci)
- `src/lib/urlSafety.ts` - walidacja URL i bezpieczny fetch (ochrona przed SSRF)
