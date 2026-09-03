import { clusterLexically } from "./lexicalClustering";
import { clusterByEmbeddings } from "./embeddingClustering";
import { clusterSemantically } from "./semanticClustering";
import { mergeContent, type MergeSource } from "./contentMerging";
import { discoverPages, type CrawlProgressCallback } from "./siteCrawler";
import { buildLinkSuggestions, findDuplicateWarnings } from "./siloPlanning";
import { extractFullPageContent, labelFromUrlSlug } from "./htmlParsing";
import { safeFetch } from "./urlSafety";
import {
  MAX_PHRASES,
  type ClusterResponse,
  type ClusteringMethod,
  type MergedContentResult,
  type PhraseCluster,
} from "./types";

// Shared by the HTTP route (src/app/api/cluster/route.ts) and the MCP
// server (src/mcp/server.ts) - both are thin wrappers around this: the
// route formats the result as JSON/NDJSON, the MCP server as tool content.
export class InvalidClusterInputError extends Error {}

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

export async function clusterPhrases(
  rawPhrases: string[],
  method: ClusteringMethod,
  pageContext: string | undefined,
): Promise<ClusterResponse> {
  const phrases = Array.from(new Set(rawPhrases.map((p) => p.trim()).filter(Boolean)));

  if (phrases.length === 0) {
    throw new InvalidClusterInputError("Podaj co najmniej jedną frazę.");
  }
  if (phrases.length > MAX_PHRASES) {
    throw new InvalidClusterInputError(`Zbyt wiele fraz (max ${MAX_PHRASES}). Podano: ${phrases.length}.`);
  }

  const clusters = await runClustering(method, phrases, pageContext, "phrases");
  return { method, clusters };
}

export async function clusterSite(
  siteUrl: string,
  method: ClusteringMethod,
  pageContext: string | undefined,
  onProgress?: CrawlProgressCallback,
): Promise<ClusterResponse> {
  const trimmedSiteUrl = siteUrl.trim();
  if (!trimmedSiteUrl) {
    throw new InvalidClusterInputError("Podaj URL strony głównej.");
  }

  const crawl = await discoverPages(trimmedSiteUrl, onProgress);
  if (crawl.pages.length === 0) {
    throw new InvalidClusterInputError("Nie udało się znaleźć żadnych podstron pod tym adresem.");
  }

  // Clustering reasons over each page's content signal (title + meta
  // description + headings + body excerpt), not its bare title - but the
  // caller still gets back the short label. Multiple pages can end up with
  // an identical signal (rare, e.g. near-duplicate content), so keep the
  // full list per signal rather than assuming a 1:1 mapping.
  const pagesBySignal = new Map<string, { label: string; url: string }[]>();
  for (const page of crawl.pages) {
    const entries = pagesBySignal.get(page.signal) ?? [];
    entries.push({ label: page.label, url: page.url });
    pagesBySignal.set(page.signal, entries);
  }

  onProgress?.({ message: "Grupowanie..." });
  const signals = Array.from(pagesBySignal.keys());
  const rawClusters = await runClustering(method, signals, pageContext || trimmedSiteUrl, "pages");

  const clusters: PhraseCluster[] = rawClusters.map((cluster) => {
    const pages = cluster.phrases.flatMap((signal) =>
      (pagesBySignal.get(signal) ?? []).map((entry) => ({ phrase: entry.label, url: entry.url })),
    );
    const displayPhrases = Array.from(new Set(pages.map((p) => p.phrase)));
    const mainPhrase = pagesBySignal.get(cluster.mainPhrase)?.[0]?.label ?? displayPhrases[0] ?? cluster.mainPhrase;

    return {
      name: cluster.name,
      mainPhrase,
      phrases: displayPhrases,
      pages,
      linkSuggestions: buildLinkSuggestions(mainPhrase, pages),
    };
  });

  return {
    method,
    clusters,
    crawl: {
      discovered: crawl.discovered,
      skipped: crawl.skipped,
      source: crawl.source,
      duplicateWarnings: findDuplicateWarnings(crawl.pages),
    },
  };
}

const MIN_MERGE_SOURCES = 2;
const MAX_MERGE_SOURCES = 6;

// Fetches each given URL fresh (independent of any prior crawl) and rewrites
// them into one consolidated piece - see src/lib/contentMerging.ts. Used by
// the MCP server's merge_similar_content tool, typically fed with a pair of
// URLs surfaced by clusterSite's crawl.duplicateWarnings.
export async function mergeSimilarContent(
  urls: string[],
  pageContext: string | undefined,
): Promise<MergedContentResult> {
  const trimmedUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));

  if (trimmedUrls.length < MIN_MERGE_SOURCES) {
    throw new InvalidClusterInputError("Podaj co najmniej dwa adresy URL do połączenia.");
  }
  if (trimmedUrls.length > MAX_MERGE_SOURCES) {
    throw new InvalidClusterInputError(`Zbyt wiele adresów URL naraz (max ${MAX_MERGE_SOURCES}).`);
  }

  const sources: MergeSource[] = await Promise.all(
    trimmedUrls.map(async (url) => {
      const res = await safeFetch(url, { timeoutMs: 8000 });
      if (!res.ok) {
        throw new InvalidClusterInputError(`Nie udało się pobrać ${url} (status ${res.status}).`);
      }
      const { title, content } = extractFullPageContent(res.text);
      if (!content) {
        throw new InvalidClusterInputError(`Strona ${url} nie ma treści do scalenia.`);
      }
      return { url: res.finalUrl, label: title || labelFromUrlSlug(res.finalUrl), content };
    }),
  );

  return mergeContent(sources, pageContext);
}
