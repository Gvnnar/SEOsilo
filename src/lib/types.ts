export type ClusteringMethod = "lexical" | "semantic";
export type ClusterInputMode = "phrases" | "crawl";

export interface ClusterPage {
  phrase: string;
  url: string;
}

export interface PhraseCluster {
  name: string;
  mainPhrase: string;
  phrases: string[];
  // Present only when the input mode was "crawl" - maps each phrase back to
  // the page it was discovered on, so the UI can link to it.
  pages?: ClusterPage[];
}

export interface ClusterResponse {
  method: ClusteringMethod;
  clusters: PhraseCluster[];
  // Present only when the input mode was "crawl".
  crawl?: {
    discovered: number;
    skipped: number;
    source: "sitemap" | "links";
  };
}

export type ClusterRequestBody = { method: ClusteringMethod; pageContext?: string } & (
  | { mode: "phrases"; phrases: string[] }
  | { mode: "crawl"; siteUrl: string }
);

export const MAX_PHRASES = 500;
