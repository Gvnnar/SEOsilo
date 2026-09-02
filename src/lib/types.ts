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

export const MAX_PHRASES = 500;
