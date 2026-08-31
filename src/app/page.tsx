"use client";

import { useEffect, useState } from "react";
import type { ClusterInputMode, ClusteringMethod, ClusterResponse, PhraseCluster } from "@/lib/types";

// Polish plural rule: 1 -> singular, 2-4 (but not 12-14) -> "few" form,
// otherwise (0, 5+, 11-14, ...) -> genitive plural.
function plPlural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const lastDigit = n % 10;
  const lastTwo = n % 100;
  if (lastDigit >= 2 && lastDigit <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
  return many;
}

function parsePhrases(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/\r?\n|,/)
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  );
}

export default function Home() {
  const [inputMode, setInputMode] = useState<ClusterInputMode>("phrases");
  const [phrasesText, setPhrasesText] = useState("");
  const [pageContext, setPageContext] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [method, setMethod] = useState<ClusteringMethod>("lexical");
  const [semanticAvailable, setSemanticAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clusters, setClusters] = useState<PhraseCluster[] | null>(null);
  const [crawlInfo, setCrawlInfo] = useState<ClusterResponse["crawl"] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/cluster")
      .then((res) => res.json())
      .then((data) => setSemanticAvailable(Boolean(data.semanticAvailable)))
      .catch(() => setSemanticAvailable(false));
  }, []);

  const phraseCount = parsePhrases(phrasesText).length;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    let requestBody: Record<string, unknown>;
    if (inputMode === "crawl") {
      if (!siteUrl.trim()) {
        setError("Podaj URL strony głównej.");
        return;
      }
      requestBody = { mode: "crawl", siteUrl: siteUrl.trim(), method };
    } else {
      const phrases = parsePhrases(phrasesText);
      if (phrases.length === 0) {
        setError("Wklej co najmniej jedną frazę.");
        return;
      }
      requestBody = { mode: "phrases", phrases, pageContext, method };
    }

    setLoading(true);
    setError(null);
    setClusters(null);
    setCrawlInfo(null);

    try {
      const res = await fetch("/api/cluster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data: ClusterResponse & { error?: string } = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Wystąpił nieznany błąd.");
      }
      setClusters(data.clusters);
      setCrawlInfo(data.crawl ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wystąpił nieznany błąd.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopyCsv() {
    if (!clusters) return;
    const hasPages = clusters.some((c) => c.pages && c.pages.length > 0);
    const rows = [hasPages ? "Klaster\tFraza główna\tFraza\tURL" : "Klaster\tFraza główna\tFraza"];
    for (const cluster of clusters) {
      if (cluster.pages && cluster.pages.length > 0) {
        for (const page of cluster.pages) {
          rows.push(`${cluster.name}\t${cluster.mainPhrase}\t${page.phrase}\t${page.url}`);
        }
      } else {
        for (const phrase of cluster.phrases) {
          rows.push(`${cluster.name}\t${cluster.mainPhrase}\t${phrase}`);
        }
      }
    }
    await navigator.clipboard.writeText(rows.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Grupowanie fraz w klastry tematyczne
        </h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Wklej listę fraz kluczowych albo podaj URL strony głównej - narzędzie pogrupuje je w silosy
          tematyczne, wskaże frazę główną w każdym klastrze i pomoże zaplanować strukturę treści.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div
          role="tablist"
          aria-label="Źródło danych"
          className="inline-flex w-fit gap-1 rounded-md border border-black/10 p-1 dark:border-white/15"
        >
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === "phrases"}
            onClick={() => setInputMode("phrases")}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              inputMode === "phrases"
                ? "bg-foreground text-background"
                : "text-black/60 dark:text-white/60"
            }`}
          >
            Wklej frazy
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={inputMode === "crawl"}
            onClick={() => setInputMode("crawl")}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              inputMode === "crawl"
                ? "bg-foreground text-background"
                : "text-black/60 dark:text-white/60"
            }`}
          >
            Podaj URL strony
          </button>
        </div>

        {inputMode === "phrases" ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Frazy kluczowe{" "}
                <span className="text-black/40 dark:text-white/40">(jedna na linię lub po przecinku)</span>
              </span>
              <textarea
                value={phrasesText}
                onChange={(e) => setPhrasesText(e.target.value)}
                rows={10}
                placeholder={"pielęgnacja trawnika\nnawożenie trawnika wiosną\njak często kosić trawnik\n..."}
                className="rounded-md border border-black/10 bg-transparent p-3 font-mono text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
              <span className="text-xs text-black/40 dark:text-white/40">{phraseCount} unikalnych fraz</span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Temat / URL strony <span className="text-black/40 dark:text-white/40">(opcjonalnie)</span>
              </span>
              <input
                type="text"
                value={pageContext}
                onChange={(e) => setPageContext(e.target.value)}
                placeholder="np. https://przyklad.pl/pielegnacja-trawnika lub 'poradnik o pielęgnacji trawnika'"
                className="rounded-md border border-black/10 bg-transparent p-2.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">URL strony głównej</span>
            <input
              type="url"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://przyklad.pl"
              className="rounded-md border border-black/10 bg-transparent p-2.5 text-sm outline-none focus:border-black/30 dark:border-white/15 dark:focus:border-white/30"
            />
            <span className="text-xs text-black/40 dark:text-white/40">
              Narzędzie samo znajdzie istniejące podstrony (sitemap.xml lub linki ze strony głównej,
              z poszanowaniem robots.txt) i pogrupuje je wg tytułów w silosy tematyczne.
            </span>
          </label>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Metoda grupowania</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-black/10 p-3 text-sm dark:border-white/15">
              <input
                type="radio"
                name="method"
                checked={method === "lexical"}
                onChange={() => setMethod("lexical")}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">Leksykalne</span>
                <span className="block text-xs text-black/50 dark:text-white/50">
                  Wspólne słowa/rdzenie, działa offline, natychmiastowe.
                </span>
              </span>
            </label>
            <label
              className={`flex items-start gap-2 rounded-md border border-black/10 p-3 text-sm dark:border-white/15 ${
                semanticAvailable ? "cursor-pointer" : "cursor-not-allowed opacity-50"
              }`}
            >
              <input
                type="radio"
                name="method"
                checked={method === "semantic"}
                disabled={!semanticAvailable}
                onChange={() => setMethod("semantic")}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">Semantyczne (AI)</span>
                <span className="block text-xs text-black/50 dark:text-white/50">
                  {semanticAvailable === false
                    ? "Wymaga ustawienia OPENROUTER_API_KEY na serwerze."
                    : "Grupuje po znaczeniu i intencji wyszukiwania, nie tylko słowach."}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={loading}
          className="self-start rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity disabled:opacity-50"
        >
          {loading
            ? inputMode === "crawl"
              ? "Skanowanie strony i grupowanie..."
              : "Grupowanie..."
            : "Pogrupuj"}
        </button>

        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </form>

      {clusters && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold">
                {clusters.length} {plPlural(clusters.length, "klaster", "klastry", "klastrów")} tematycznych
              </h2>
              {crawlInfo && (
                <p className="text-xs text-black/50 dark:text-white/50">
                  Znaleziono {crawlInfo.discovered}{" "}
                  {plPlural(crawlInfo.discovered, "podstronę", "podstrony", "podstron")}
                  {crawlInfo.skipped > 0 ? ` (pominięto ${crawlInfo.skipped})` : ""} ·{" "}
                  {crawlInfo.source === "sitemap" ? "źródło: sitemap.xml" : "źródło: linki ze strony głównej"}
                </p>
              )}
            </div>
            <button
              onClick={handleCopyCsv}
              className="rounded-md border border-black/10 px-3 py-1.5 text-xs font-medium dark:border-white/15"
            >
              {copied ? "Skopiowano!" : "Kopiuj jako CSV"}
            </button>
          </div>

          <ul className="flex flex-col gap-3">
            {clusters.map((cluster, i) => (
              <li key={i} className="rounded-lg border border-black/10 p-4 dark:border-white/15">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-semibold">{cluster.name}</h3>
                  <span className="text-xs text-black/40 dark:text-white/40">
                    {cluster.phrases.length} {plPlural(cluster.phrases.length, "fraza", "frazy", "fraz")}
                  </span>
                </div>
                <p className="mb-3 text-xs text-black/50 dark:text-white/50">
                  Fraza główna: <span className="font-medium text-black/80 dark:text-white/80">{cluster.mainPhrase}</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {cluster.pages && cluster.pages.length > 0
                    ? cluster.pages.map((page, j) => (
                        <a
                          key={`${page.url}-${j}`}
                          href={page.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={page.url}
                          className="rounded-full bg-black/5 px-2.5 py-1 text-xs underline decoration-black/20 hover:bg-black/10 dark:bg-white/10 dark:decoration-white/20 dark:hover:bg-white/15"
                        >
                          {page.phrase}
                        </a>
                      ))
                    : cluster.phrases.map((phrase) => (
                        <span
                          key={phrase}
                          className="rounded-full bg-black/5 px-2.5 py-1 text-xs dark:bg-white/10"
                        >
                          {phrase}
                        </span>
                      ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
