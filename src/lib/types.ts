export type ClusteringMethod = "lexical" | "semantic";

export interface PhraseCluster {
  name: string;
  mainPhrase: string;
  phrases: string[];
}

export interface ClusterResponse {
  method: ClusteringMethod;
  clusters: PhraseCluster[];
}

export interface ClusterRequestBody {
  phrases: string[];
  pageContext?: string;
  method: ClusteringMethod;
}

export const MAX_PHRASES = 500;
