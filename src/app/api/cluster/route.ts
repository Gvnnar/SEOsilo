import { NextResponse } from "next/server";
import { clusterLexically } from "@/lib/lexicalClustering";
import {
  clusterSemantically,
  isSemanticClusteringAvailable,
  SemanticClusteringUnavailableError,
} from "@/lib/semanticClustering";
import { discoverPages } from "@/lib/siteCrawler";
import { SsrfBlockedError } from "@/lib/urlSafety";
import {
  MAX_PHRASES,
  type ClusterRequestBody,
  type ClusterResponse,
  type PhraseCluster,
} from "@/lib/types";

// Crawling a site (fetching robots.txt, a sitemap, and a batch of pages) can
// comfortably exceed the default serverless timeout on some hosts.
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ semanticAvailable: isSemanticClusteringAvailable() });
}

async function runClustering(
  method: "lexical" | "semantic",
  phrases: string[],
  pageContext: string | undefined,
  contentKind: "phrases" | "pages",
) {
  return method === "semantic"
    ? clusterSemantically(phrases, pageContext, contentKind)
    : clusterLexically(phrases, { longDocuments: contentKind === "pages" });
}

export async function POST(request: Request) {
  let body: ClusterRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowy JSON w treści żądania." }, { status: 400 });
  }

  const method = body.method === "semantic" ? "semantic" : "lexical";
  const pageContext = typeof body.pageContext === "string" ? body.pageContext : undefined;

  try {
    if (body.mode === "crawl") {
      return await handleCrawlMode(body.siteUrl, method, pageContext);
    }
    return await handlePhrasesMode(body.phrases, method, pageContext);
  } catch (error) {
    if (error instanceof SemanticClusteringUnavailableError || error instanceof SsrfBlockedError) {
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
  method: "lexical" | "semantic",
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

async function handleCrawlMode(
  siteUrl: unknown,
  method: "lexical" | "semantic",
  pageContext: string | undefined,
) {
  if (typeof siteUrl !== "string" || !siteUrl.trim()) {
    return NextResponse.json({ error: "Podaj URL strony głównej." }, { status: 400 });
  }

  const crawl = await discoverPages(siteUrl.trim());
  if (crawl.pages.length === 0) {
    return NextResponse.json(
      { error: "Nie udało się znaleźć żadnych podstron pod tym adresem." },
      { status: 400 },
    );
  }

  // Clustering reasons over each page's content signal (title + meta
  // description + headings), not its bare title - but the UI and CSV
  // export still show the short label. Multiple pages can end up with an
  // identical signal (rare, e.g. near-duplicate content), so keep the full
  // list per signal rather than assuming a 1:1 mapping.
  const pagesBySignal = new Map<string, { label: string; url: string }[]>();
  for (const page of crawl.pages) {
    const entries = pagesBySignal.get(page.signal) ?? [];
    entries.push({ label: page.label, url: page.url });
    pagesBySignal.set(page.signal, entries);
  }

  const signals = Array.from(pagesBySignal.keys());
  const rawClusters = await runClustering(method, signals, pageContext || siteUrl.trim(), "pages");

  const clusters: PhraseCluster[] = rawClusters.map((cluster) => {
    const pages = cluster.phrases.flatMap((signal) =>
      (pagesBySignal.get(signal) ?? []).map((entry) => ({ phrase: entry.label, url: entry.url })),
    );
    const displayPhrases = Array.from(new Set(pages.map((p) => p.phrase)));
    const mainPhrase = pagesBySignal.get(cluster.mainPhrase)?.[0]?.label ?? displayPhrases[0] ?? cluster.mainPhrase;

    return { name: cluster.name, mainPhrase, phrases: displayPhrases, pages };
  });

  const responseBody: ClusterResponse = {
    method,
    clusters,
    crawl: { discovered: crawl.discovered, skipped: crawl.skipped, source: crawl.source },
  };
  return NextResponse.json(responseBody);
}
