# SEOsilo

Narzędzie do grupowania fraz kluczowych w klastry (silosy) tematyczne dla danej strony -
przydatne przy planowaniu treści i architektury informacji serwisu.

Dostępne są dwie metody grupowania:

- **Leksykalna** - działa w pełni offline, bez klucza API. Grupuje frazy na podstawie
  wspólnych znaczących słów (podobieństwo Jaccarda).
- **Semantyczna (AI)** - wykorzystuje Claude do grupowania po znaczeniu i intencji
  wyszukiwania, nie tylko wspólnych słowach. Wymaga klucza `ANTHROPIC_API_KEY`.

## Uruchomienie

```bash
npm install
npm run dev
```

Otwórz [http://localhost:3000](http://localhost:3000).

## Konfiguracja grupowania semantycznego (opcjonalnie)

Skopiuj `.env.example` do `.env.local` i uzupełnij klucz API:

```bash
cp .env.example .env.local
```

```
ANTHROPIC_API_KEY=sk-ant-...
```

Bez klucza aplikacja nadal działa - dostępna jest wtedy tylko metoda leksykalna.

## Struktura

- `src/app/page.tsx` - interfejs narzędzia (formularz + wyniki grupowania)
- `src/app/api/cluster/route.ts` - endpoint API (`GET` sprawdza dostępność metody
  semantycznej, `POST` wykonuje grupowanie)
- `src/lib/lexicalClustering.ts` - grupowanie leksykalne (offline)
- `src/lib/semanticClustering.ts` - grupowanie semantyczne przez Claude API
