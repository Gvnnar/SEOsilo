import crypto from "node:crypto";
import OpenAI from "openai";
import { agglomerativeCluster } from "./agglomerativeCluster";
import { buildCluster, tokenize } from "./lexicalClustering";
import type { PhraseCluster } from "./types";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

// Cosine-similarity threshold for merging two items into the same cluster.
// text-embedding-3-small tends to put related short texts (same topic,
// different wording) around ~0.5-0.7 and unrelated ones well below ~0.3,
// but this is a starting point, not something validated against this app's
// real traffic - there was no live OPENROUTER_API_KEY available to tune it
// empirically. Revisit once real clustering runs are observable; expose as
// an env override in the meantime rather than hardcoding it as final.
const DEFAULT_SIMILARITY_THRESHOLD = 0.55;

export class EmbeddingClusteringUnavailableError extends Error {}

export function isEmbeddingClusteringAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function getClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
  });
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Keyed by sha256(text) -> embedding vector. Process-lifetime, same pattern
// as rateLimit.ts's buckets - avoids paying for or waiting on an API call
// to re-embed text a previous request in this process already embedded
// (a common workflow: re-run clustering on the same site after tweaking
// the method or context).
const embeddingCache = new Map<string, number[]>();

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const hashes = texts.map(hashText);
  const uncachedPositions = hashes
    .map((hash, position) => (embeddingCache.has(hash) ? -1 : position))
    .filter((position) => position !== -1);

  if (uncachedPositions.length > 0) {
    const client = getClient();
    const model = process.env.OPENROUTER_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

    const response = await client.embeddings.create({
      model,
      input: uncachedPositions.map((position) => texts[position]),
      // The SDK defaults to requesting base64-encoded embeddings and
      // decoding them locally when this is omitted - an OpenAI-specific
      // optimization that isn't guaranteed to round-trip correctly through
      // every model OpenRouter proxies to. Explicit "float" is the portable
      // choice across providers.
      encoding_format: "float",
    });

    for (const item of response.data) {
      const originalPosition = uncachedPositions[item.index];
      embeddingCache.set(hashes[originalPosition], item.embedding);
    }
  }

  return hashes.map((hash) => {
    const vector = embeddingCache.get(hash);
    if (!vector) throw new Error(`Brak wektora embeddingu dla wejścia po zapytaniu do API.`);
    return vector;
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function clusterByEmbeddings(phrases: string[]): Promise<PhraseCluster[]> {
  if (!isEmbeddingClusteringAvailable()) {
    throw new EmbeddingClusteringUnavailableError(
      "Brak skonfigurowanego OPENROUTER_API_KEY - grupowanie przez embeddingi jest niedostępne.",
    );
  }

  const vectors = await getEmbeddings(phrases);
  const threshold = Number(process.env.EMBEDDING_SIMILARITY_THRESHOLD) || DEFAULT_SIMILARITY_THRESHOLD;

  const groups = agglomerativeCluster(
    phrases.length,
    (i, j) => cosineSimilarity(vectors[i], vectors[j]),
    threshold,
  );

  // Grouping decisions come from embeddings, but the same lexical
  // keyword-frequency heuristic still gives a readable cluster name and
  // pillar phrase - reusing it here avoids a second naming scheme.
  const tokenSets = phrases.map((phrase) => new Set(tokenize(phrase)));
  const clusters = groups.map((indices) =>
    buildCluster(
      indices.map((i) => phrases[i]),
      indices.map((i) => tokenSets[i]),
    ),
  );

  clusters.sort((a, b) => b.phrases.length - a.phrases.length);
  return clusters;
}
