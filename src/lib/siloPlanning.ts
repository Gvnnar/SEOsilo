import { textSimilarity } from "./lexicalClustering";
import type { DiscoveredPage } from "./siteCrawler";
import type { DuplicateWarning, LinkSuggestion } from "./types";

// Two page signals sharing this much of their vocabulary are flagged as a
// possible duplicate-content / keyword-cannibalization risk. Well above the
// clustering threshold (0.24) - this is meant to catch near-duplicates, not
// merely "same topic" (clustering already does that).
const DUPLICATE_SIMILARITY_THRESHOLD = 0.7;

// Standard silo internal-linking pattern: the cluster's pillar page (the
// one matching mainPhrase) links out to every supporting page, and each
// supporting page links back to the pillar - both directions suggested
// with the target page's own label as anchor text.
export function buildLinkSuggestions(
  mainPhrase: string,
  pages: { phrase: string; url: string }[],
): LinkSuggestion[] | undefined {
  if (pages.length < 2) return undefined;

  const pillarIndex = pages.findIndex((p) => p.phrase === mainPhrase);
  const pillar = pillarIndex >= 0 ? pages[pillarIndex] : pages[0];
  const spokes = pages.filter((p) => p.url !== pillar.url);
  if (spokes.length === 0) return undefined;

  const suggestions: LinkSuggestion[] = [];
  for (const spoke of spokes) {
    suggestions.push({
      fromUrl: pillar.url,
      fromLabel: pillar.phrase,
      toUrl: spoke.url,
      toLabel: spoke.phrase,
      anchor: spoke.phrase,
    });
    suggestions.push({
      fromUrl: spoke.url,
      fromLabel: spoke.phrase,
      toUrl: pillar.url,
      toLabel: pillar.phrase,
      anchor: pillar.phrase,
    });
  }
  return suggestions;
}

// Flags page pairs whose content signal overlaps heavily - independent of
// final cluster membership, since two near-duplicate pages could in
// principle land in different clusters depending on the rest of the corpus.
export function findDuplicateWarnings(pages: DiscoveredPage[]): DuplicateWarning[] {
  const warnings: DuplicateWarning[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const similarity = textSimilarity(pages[i].signal, pages[j].signal, { longDocuments: true });
      if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        warnings.push({
          urlA: pages[i].url,
          labelA: pages[i].label,
          urlB: pages[j].url,
          labelB: pages[j].label,
          similarity,
        });
      }
    }
  }
  return warnings.sort((a, b) => b.similarity - a.similarity);
}
