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

function tokenize(phrase: string): string[] {
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

interface ClusterNode {
  members: number[];
}

// Average-link (UPGMA) agglomerative clustering: repeatedly merges the two
// clusters with the highest *average* pairwise similarity, stopping once no
// pair clears the threshold. Single-link (union-find over any-pair-matches)
// chains unrelated phrases together transitively (A-B and B-C linked makes
// A-C the same cluster even if unrelated); averaging over every member pair
// avoids that chaining effect.
export function clusterLexically(
  phrases: string[],
  options: { longDocuments?: boolean } = {},
): PhraseCluster[] {
  const similarity = options.longDocuments ? overlapCoefficient : jaccard;
  const n = phrases.length;
  const tokenSets = phrases.map((phrase) => new Set(tokenize(phrase)));

  const active = new Map<number, ClusterNode>();
  for (let i = 0; i < n; i++) active.set(i, { members: [i] });

  // sumSim[a][b] = sum of similarity(tokenSets[i], tokenSets[j]) over all
  // original-phrase pairs (i, j) with i in cluster a, j in cluster b.
  const sumSim = new Map<number, Map<number, number>>();
  const setSim = (a: number, b: number, v: number) => {
    if (!sumSim.has(a)) sumSim.set(a, new Map());
    if (!sumSim.has(b)) sumSim.set(b, new Map());
    sumSim.get(a)!.set(b, v);
    sumSim.get(b)!.set(a, v);
  };
  const getSim = (a: number, b: number) => sumSim.get(a)?.get(b) ?? 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      setSim(i, j, similarity(tokenSets[i], tokenSets[j]));
    }
  }

  let nextId = n;
  while (active.size > 1) {
    const ids = Array.from(active.keys());
    let bestA = -1;
    let bestB = -1;
    let bestAvg = -Infinity;

    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const a = ids[x];
        const b = ids[y];
        const sizeA = active.get(a)!.members.length;
        const sizeB = active.get(b)!.members.length;
        const avg = getSim(a, b) / (sizeA * sizeB);
        if (avg > bestAvg) {
          bestAvg = avg;
          bestA = a;
          bestB = b;
        }
      }
    }

    if (bestAvg < SIMILARITY_THRESHOLD) break;

    const nodeA = active.get(bestA)!;
    const nodeB = active.get(bestB)!;
    const mergedId = nextId++;

    for (const otherId of active.keys()) {
      if (otherId === bestA || otherId === bestB) continue;
      setSim(mergedId, otherId, getSim(bestA, otherId) + getSim(bestB, otherId));
    }

    sumSim.delete(bestA);
    sumSim.delete(bestB);
    for (const row of sumSim.values()) {
      row.delete(bestA);
      row.delete(bestB);
    }

    active.delete(bestA);
    active.delete(bestB);
    active.set(mergedId, { members: [...nodeA.members, ...nodeB.members] });
  }

  const clusters = Array.from(active.values()).map((node) =>
    buildCluster(
      node.members.map((i) => phrases[i]),
      node.members.map((i) => tokenSets[i]),
    ),
  );

  clusters.sort((a, b) => b.phrases.length - a.phrases.length);
  return clusters;
}

function buildCluster(phrases: string[], tokenSets: Set<string>[]): PhraseCluster {
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
