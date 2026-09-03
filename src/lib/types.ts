export type ClusteringMethod = "lexical" | "embeddings" | "semantic";
export type ClusterInputMode = "phrases" | "crawl";

export interface ClusterPage {
  phrase: string;
  url: string;
}

export interface LinkSuggestion {
  fromUrl: string;
  fromLabel: string;
  toUrl: string;
  toLabel: string;
  // Suggested anchor text for the link - the target page's label.
  anchor: string;
}

export interface PhraseCluster {
  name: string;
  mainPhrase: string;
  phrases: string[];
  // Present only when the input mode was "crawl" - maps each phrase back to
  // the page it was discovered on, so the UI can link to it.
  pages?: ClusterPage[];
  // Present only when the input mode was "crawl" and the cluster has more
  // than one page - a pillar/spoke internal-linking plan: the cluster's
  // main page links out to every other page, and each of those links back.
  linkSuggestions?: LinkSuggestion[];
}

export interface DuplicateWarning {
  urlA: string;
  labelA: string;
  urlB: string;
  labelB: string;
  similarity: number;
}

// Result of rewriting several near-duplicate pages into one consolidated
// piece (src/lib/contentMerging.ts) - exposed through the MCP server only.
export interface MergedContentResult {
  // The source URL kept as canonical (heuristically: the one with the most
  // existing content) - where the merged content should be published.
  primaryUrl: string;
  primaryLabel: string;
  // The other source URLs, which should 301-redirect to primaryUrl once the
  // merged content is published - standard content-consolidation practice.
  redirectFromUrls: string[];
  title: string;
  metaDescription: string;
  // Full merged article body, in Markdown.
  content: string;
  sources: { url: string; label: string }[];
}

export interface ClusterResponse {
  method: ClusteringMethod;
  clusters: PhraseCluster[];
  // Present only when the input mode was "crawl".
  crawl?: {
    discovered: number;
    skipped: number;
    source: "sitemap" | "links";
    // Pages whose content signal is suspiciously similar - a possible
    // keyword-cannibalization or duplicate-content risk worth a manual look.
    duplicateWarnings: DuplicateWarning[];
  };
}

export type ClusterRequestBody = { method: ClusteringMethod; pageContext?: string } & (
  | { mode: "phrases"; phrases: string[] }
  | { mode: "crawl"; siteUrl: string }
);

// Crawl mode streams these as newline-delimited JSON (one per line) instead
// of a single response body, so the UI can show live progress through a
// crawl that can take several seconds.
export type CrawlStreamEvent =
  | { type: "status"; message: string; fetched?: number; total?: number }
  | { type: "done"; result: ClusterResponse }
  | { type: "error"; message: string };

export const MAX_PHRASES = 500;
