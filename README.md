# SEOsilo

Narzędzie do grupowania fraz kluczowych w klastry (silosy) tematyczne dla danej strony -
przydatne przy planowaniu treści i architektury informacji serwisu.

Dostępne są dwie metody grupowania:

- **Leksykalna** - działa w pełni offline, bez klucza API. Grupuje frazy na podstawie
  wspólnych znaczących słów (podobieństwo Jaccarda).
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

- `src/app/page.tsx` - interfejs narzędzia (formularz + wyniki grupowania)
- `src/app/api/cluster/route.ts` - endpoint API (`GET` sprawdza dostępność metody
  semantycznej, `POST` wykonuje grupowanie)
- `src/lib/lexicalClustering.ts` - grupowanie leksykalne (offline)
- `src/lib/semanticClustering.ts` - grupowanie semantyczne przez OpenRouter
