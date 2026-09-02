import { NextResponse } from "next/server";
import { clusterLexically } from "@/lib/lexicalClustering";
import {
  clusterByEmbeddings,
  isEmbeddingClusteringAvailable,
  EmbeddingClusteringUnavailableError,
} from "@/lib/embeddingClustering";
import {
  clusterSemantically,
  isSemanticClusteringAvailable,
  SemanticClusteringUnavailableError,
} from "@/lib/semanticClustering";
import { discoverPages } from "@/lib/siteCrawler";
import { buildLinkSuggestions, findDuplicateWarnings } from "@/lib/siloPlanning";
import { SsrfBlockedError } from "@/lib/urlSafety";
import { checkRateLimit, clientKeyFromRequest } from "@/lib/rateLimit";
import {
  MAX_PHRASES,
  type ClusterRequestBody,
  type ClusterResponse,
  type ClusteringMethod,
  type CrawlStreamEvent,
  type PhraseCluster,
} from "@/lib/types";

// Crawling a site (fetching robots.txt, a sitemap, and a batch of pages) can
// comfortably exceed the default serverless timeout on some hosts.
export const maxDuration = 60;

// Generous limit for normal interactive use of either mode.
const GENERAL_LIMIT = { max: 30, windowMs: 5 * 60_000 };
// Crawl mode fetches many external pages per call, and the embeddings/
// semantic methods call a paid API - all cost real money/bandwidth, so they
// share a stricter budget on top of the general one.
const EXPENSIVE_LIMIT = { max: 8, windowMs: 10 * 60_000 };

export async function GET() {
  // Embeddings and the semantic method are gated on the same credential
  // (OPENROUTER_API_KEY) - one flag covers both.
  return NextResponse.json({ aiAvailable: isSemanticClusteringAvailable() || isEmbeddingClusteringAvailable() });
}

async function runClustering(
  method: ClusteringMethod,
  phrases: string[],
  pageContext: string | undefined,
  contentKind: "phrases" | "pages",
) {
  if (method === "semantic") return clusterSemantically(phrases, pageContext, contentKind);
  if (method === "embeddings") return clusterByEmbeddings(phrases);
  return clusterLexically(phrases, { longDocuments: contentKind === "pages" });
}

export async function POST(request: Request) {
  let body: ClusterRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowy JSON w treści żądania." }, { status: 400 });
  }

  const method: ClusteringMethod =
    body.method === "semantic" || body.method === "embeddings" ? body.method : "lexical";
  const pageContext = typeof body.pageContext === "string" ? body.pageContext : undefined;
  const isExpensive = body.mode === "crawl" || method === "semantic" || method === "embeddings";

  const clientKey = clientKeyFromRequest(request);
  const general = checkRateLimit(`general:${clientKey}`, GENERAL_LIMIT.max, GENERAL_LIMIT.windowMs);
  const expensive = isExpensive
    ? checkRateLimit(`expensive:${clientKey}`, EXPENSIVE_LIMIT.max, EXPENSIVE_LIMIT.windowMs)
    : { allowed: true, retryAfterSeconds: 0 };

  if (!general.allowed || !expensive.allowed) {
    const retryAfterSeconds = Math.max(general.retryAfterSeconds, expensive.retryAfterSeconds);
    return NextResponse.json(
      { error: `Zbyt wiele żądań. Spróbuj ponownie za ${retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  if (body.mode === "crawl") {
    return handleCrawlMode(body.siteUrl, method, pageContext);
  }

  try {
    return await handlePhrasesMode(body.phrases, method, pageContext);
  } catch (error) {
    if (
      error instanceof SemanticClusteringUnavailableError ||
      error instanceof EmbeddingClusteringUnavailableError ||
      error instanceof SsrfBlockedError
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Cluster generation failed:", error);
    return NextResponse.json(
      { error: "Nie udało się wygenerować grupowania. Spróbuj ponownie." },
      { status: 500 },
    );
  }
}

async function handlePhrasesMode(
  rawPhrases: unknown,
  method: ClusteringMethod,
  pageContext: string | undefined,
) {
  const phrases = Array.from(
    new Set(
      (Array.isArray(rawPhrases) ? rawPhrases : [])
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean),
    ),
  );

  if (phrases.length === 0) {
    return NextResponse.json({ error: "Podaj co najmniej jedną frazę." }, { status: 400 });
  }
  if (phrases.length > MAX_PHRASES) {
    return NextResponse.json(
      { error: `Zbyt wiele fraz (max ${MAX_PHRASES}). Podano: ${phrases.length}.` },
      { status: 400 },
    );
  }

  const clusters = await runClustering(method, phrases, pageContext, "phrases");
  const responseBody: ClusterResponse = { method, clusters };
  return NextResponse.json(responseBody);
}

// Crawl mode can take several seconds (robots.txt + sitemap/link discovery +
// N page fetches), so it streams newline-delimited progress events instead
// of making the client wait on one opaque request. The HTTP status is
// always 200 once the stream starts (it has to be - the status line is
// already sent); failures surface as a final { type: "error" } line instead.
function handleCrawlMode(
  siteUrl: unknown,
  method: ClusteringMethod,
  pageContext: string | undefined,
): Response {
  if (typeof siteUrl !== "string" || !siteUrl.trim()) {
    return NextResponse.json({ error: "Podaj URL strony głównej." }, { status: 400 });
  }
  const trimmedSiteUrl = siteUrl.trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: CrawlStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const crawl = await discoverPages(trimmedSiteUrl, (progress) => {
          send({ type: "status", message: progress.message, fetched: progress.fetched, total: progress.total });
        });

        if (crawl.pages.length === 0) {
          send({ type: "error", message: "Nie udało się znaleźć żadnych podstron pod tym adresem." });
          return;
        }

        send({ type: "status", message: "Grupowanie..." });

        // Clustering reasons over each page's content signal (title + meta
        // description + headings), not its bare title - but the UI and CSV
        // export still show the short label. Multiple pages can end up with
        // an identical signal (rare, e.g. near-duplicate content), so keep
        // the full list per signal rather than assuming a 1:1 mapping.
        const pagesBySignal = new Map<string, { label: string; url: string }[]>();
        for (const page of crawl.pages) {
          const entries = pagesBySignal.get(page.signal) ?? [];
          entries.push({ label: page.label, url: page.url });
          pagesBySignal.set(page.signal, entries);
        }

        const signals = Array.from(pagesBySignal.keys());
        const rawClusters = await runClustering(method, signals, pageContext || trimmedSiteUrl, "pages");

        const clusters: PhraseCluster[] = rawClusters.map((cluster) => {
          const pages = cluster.phrases.flatMap((signal) =>
            (pagesBySignal.get(signal) ?? []).map((entry) => ({ phrase: entry.label, url: entry.url })),
          );
          const displayPhrases = Array.from(new Set(pages.map((p) => p.phrase)));
          const mainPhrase =
            pagesBySignal.get(cluster.mainPhrase)?.[0]?.label ?? displayPhrases[0] ?? cluster.mainPhrase;

          return {
            name: cluster.name,
            mainPhrase,
            phrases: displayPhrases,
            pages,
            linkSuggestions: buildLinkSuggestions(mainPhrase, pages),
          };
        });

        const result: ClusterResponse = {
          method,
          clusters,
          crawl: {
            discovered: crawl.discovered,
            skipped: crawl.skipped,
            source: crawl.source,
            duplicateWarnings: findDuplicateWarnings(crawl.pages),
          },
        };
        send({ type: "done", result });
      } catch (error) {
        if (
          error instanceof SemanticClusteringUnavailableError ||
          error instanceof EmbeddingClusteringUnavailableError ||
          error instanceof SsrfBlockedError
        ) {
          send({ type: "error", message: error.message });
        } else {
          console.error("Cluster generation failed:", error);
          send({ type: "error", message: "Nie udało się wygenerować grupowania. Spróbuj ponownie." });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
