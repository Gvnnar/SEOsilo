import { agglomerativeCluster } from "./agglomerativeCluster";
import type { PhraseCluster } from "./types";

// Polish (plus a handful of common English) function words - excluded so
// clustering keys off the meaningful nouns/adjectives that actually signal topic.
const STOPWORDS = new Set([
  "i", "w", "z", "ze", "na", "do", "od", "dla", "o", "u", "po", "przez",
  "nad", "pod", "za", "przy", "między", "bez", "jak", "co", "czy", "to",
  "się", "jest", "są", "być", "oraz", "a", "ale", "lub", "czyli", "jako",
  "tak", "nie", "ich", "jego", "jej", "ten", "ta", "te", "tym", "tego",
  "tej", "tych", "swoje", "swój", "ile", "gdzie", "kiedy", "the", "an",
  "of", "for", "on", "and", "or",
]);

export function tokenize(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// |A∩B| / min(|A|,|B|): "how much of the smaller set is contained in the
// larger one". Jaccard's union-sized denominator makes it too strict once
// one side is much bigger than the other (a whole page's title + meta +
// headings vs. another page's) - a short document sharing every one of its
// words with a much longer one still scores low, purely because the long
// side has many more unique words. Only worth the tradeoff for that
// size-imbalanced case: on same-length short phrases it swings the other
// way and over-merges (a single shared word out of a 2-word phrase already
// scores 0.5), so it's opt-in via clusterLexically's `longDocuments` flag,
// not a blanket replacement for jaccard().
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

// Two phrases are linked (same cluster) once they share enough of their
// significant words.
const SIMILARITY_THRESHOLD = 0.24;

// Reusable outside clustering itself (e.g. flagging near-duplicate page
// content) - same tokenization and metric choice as clusterLexically().
export function textSimilarity(a: string, b: string, options: { longDocuments?: boolean } = {}): number {
  const similarity = options.longDocuments ? overlapCoefficient : jaccard;
  return similarity(new Set(tokenize(a)), new Set(tokenize(b)));
}

export function clusterLexically(
  phrases: string[],
  options: { longDocuments?: boolean } = {},
): PhraseCluster[] {
  const similarity = options.longDocuments ? overlapCoefficient : jaccard;
  const tokenSets = phrases.map((phrase) => new Set(tokenize(phrase)));

  const groups = agglomerativeCluster(
    phrases.length,
    (i, j) => similarity(tokenSets[i], tokenSets[j]),
    SIMILARITY_THRESHOLD,
  );

  const clusters = groups.map((indices) =>
    buildCluster(
      indices.map((i) => phrases[i]),
      indices.map((i) => tokenSets[i]),
    ),
  );

  clusters.sort((a, b) => b.phrases.length - a.phrases.length);
  return clusters;
}

// Exported for reuse by other clustering strategies (e.g. embeddingClustering.ts)
// that decide *grouping* by a different signal but still want this same
// keyword-frequency naming/pillar-phrase heuristic for display.
export function buildCluster(phrases: string[], tokenSets: Set<string>[]): PhraseCluster {
  const frequency = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  const topTokens = Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([token]) => token[0].toUpperCase() + token.slice(1));

  const name = topTokens.length > 0 ? topTokens.join(" ") : phrases[0];

  // The most generic (fewest-word) phrase makes the best pillar/main phrase.
  const mainPhrase = [...phrases].sort(
    (a, b) => tokenize(a).length - tokenize(b).length || a.length - b.length,
  )[0];

  return { name, mainPhrase, phrases: [...phrases].sort() };
}
