import { safeFetch, assertPublicHttpUrl, SsrfBlockedError } from "./urlSafety";
import {
  extractLinks,
  extractPageSignal,
  buildClusteringText,
  labelFromUrlSlug,
  parseSitemapLocs,
  parseRobotsDisallow,
  isDisallowedByRobots,
  sitemapKind,
} from "./htmlParsing";

export interface DiscoveredPage {
  url: string;
  // Short, human-readable label (title, falling back to H1 or URL slug) -
  // what the UI shows and what CSV export uses.
  label: string;
  // Richer per-page text (title + meta description + H1-H3 headings) that
  // clustering actually reasons over, so pages get analyzed individually
  // rather than grouped from the title alone.
  signal: string;
}

export interface CrawlResult {
  pages: DiscoveredPage[];
  discovered: number;
  skipped: number;
  source: "sitemap" | "links";
}

export interface CrawlProgressEvent {
  message: string;
  // Present only once page fetching has started - lets the UI show a "X/N".
  fetched?: number;
  total?: number;
}

export type CrawlProgressCallback = (event: CrawlProgressEvent) => void;

const MAX_PAGES_FROM_SITEMAP = 80;
const MAX_PAGES_FROM_LINKS = 60;
const MAX_SUB_SITEMAPS = 3;
// How many pages to fetch at once. Configurable (CRAWL_CONCURRENCY) since
// the right value trades off crawl speed against politeness toward the
// target site and the deployment's own outbound connection limits - capped
// so a misconfigured env var can't turn this into a stress test.
const DEFAULT_PAGE_FETCH_CONCURRENCY = 8;
const MAX_PAGE_FETCH_CONCURRENCY = 16;
function resolvePageFetchConcurrency(): number {
  const fromEnv = Number(process.env.CRAWL_CONCURRENCY);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(Math.floor(fromEnv), MAX_PAGE_FETCH_CONCURRENCY);
  }
  return DEFAULT_PAGE_FETCH_CONCURRENCY;
}
const PAGE_FETCH_CONCURRENCY = resolvePageFetchConcurrency();
const PAGE_FETCH_TIMEOUT_MS = 6000;
// Below this many same-origin links on the homepage, its nav is probably
// too sparse to represent the whole site (e.g. a "Blog" link but no
// individual post links) - worth one bounded extra hop.
const SPARSE_LINKS_THRESHOLD = 20;
const SECOND_LEVEL_PAGE_LIMIT = 10;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchRobotsDisallowRules(origin: string): Promise<string[]> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 5000, maxBytes: 200_000 });
    return res.ok ? parseRobotsDisallow(res.text) : [];
  } catch {
    return [];
  }
}

async function collectSitemapUrls(origin: string): Promise<string[]> {
  let res;
  try {
    res = await safeFetch(`${origin}/sitemap.xml`, { timeoutMs: 6000, maxBytes: 3_000_000 });
  } catch {
    return [];
  }
  if (!res.ok || !res.text) return [];

  const kind = sitemapKind(res.text);
  if (kind === "unknown") return [];

  const locs = parseSitemapLocs(res.text);

  if (kind === "urlset") return locs;

  // Sitemap index: fetch a handful of child sitemaps and flatten their URLs.
  const childSitemaps = locs.slice(0, MAX_SUB_SITEMAPS);
  const childUrlLists = await mapWithConcurrency(childSitemaps, PAGE_FETCH_CONCURRENCY, async (sitemapUrl) => {
    try {
      const child = await safeFetch(sitemapUrl, { timeoutMs: 6000, maxBytes: 3_000_000 });
      if (!child.ok || sitemapKind(child.text) !== "urlset") return [];
      return parseSitemapLocs(child.text);
    } catch {
      return [];
    }
  });

  return childUrlLists.flat();
}

function sameOriginLinks(html: string, baseUrl: string, origin: string): string[] {
  return extractLinks(html, baseUrl).filter((link) => new URL(link).origin === origin);
}

// No sitemap - fall back to whatever the homepage links to, and if that nav
// looks sparse, one bounded extra hop through those pages to surface links
// the homepage itself doesn't carry (e.g. individual posts linked only from
// a "Blog" index page, not from the homepage nav).
async function collectLinksFromSite(origin: string, homepageHtml: string): Promise<string[]> {
  const levelOne = new Set(sameOriginLinks(homepageHtml, origin, origin));

  if (levelOne.size < SPARSE_LINKS_THRESHOLD) {
    const toExpand = Array.from(levelOne).slice(0, SECOND_LEVEL_PAGE_LIMIT);
    const levelTwoLists = await mapWithConcurrency(toExpand, PAGE_FETCH_CONCURRENCY, async (pageUrl) => {
      try {
        const res = await safeFetch(pageUrl, { timeoutMs: PAGE_FETCH_TIMEOUT_MS });
        return res.ok ? sameOriginLinks(res.text, pageUrl, origin) : [];
      } catch {
        return [];
      }
    });
    for (const list of levelTwoLists) for (const link of list) levelOne.add(link);
  }

  return Array.from(levelOne);
}

export async function discoverPages(
  siteUrlInput: string,
  onProgress?: CrawlProgressCallback,
): Promise<CrawlResult> {
  const validated = await assertPublicHttpUrl(siteUrlInput);
  const origin = validated.origin;

  // Homepage, robots.txt and sitemap.xml are three independent requests -
  // none needs another's result - so fetch all three concurrently instead
  // of paying for three sequential round trips before any page discovery
  // can even start.
  onProgress?.({ message: "Pobieram stronę główną i sprawdzam sitemap.xml..." });
  const [homepage, disallowRules, sitemapUrls] = await Promise.all([
    safeFetch(origin, { timeoutMs: 8000 }),
    fetchRobotsDisallowRules(origin),
    collectSitemapUrls(origin),
  ]);
  if (!homepage.ok) {
    throw new SsrfBlockedError(`Nie udało się pobrać strony głównej (status ${homepage.status}).`);
  }

  let candidateUrls = sitemapUrls;
  let source: CrawlResult["source"] = "sitemap";

  if (candidateUrls.length === 0) {
    onProgress?.({ message: "Brak sitemap.xml - szukam linków ze strony głównej..." });
    candidateUrls = await collectLinksFromSite(origin, homepage.text);
    source = "links";
  }

  // The homepage itself is always a candidate page, even if it's absent
  // from the sitemap or isn't linked from its own nav.
  candidateUrls = [`${origin}/`, ...candidateUrls];

  candidateUrls = Array.from(new Set(candidateUrls)).filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && !isDisallowedByRobots(parsed.pathname, disallowRules);
    } catch {
      return false;
    }
  });

  const cap = source === "sitemap" ? MAX_PAGES_FROM_SITEMAP : MAX_PAGES_FROM_LINKS;
  const limited = candidateUrls.slice(0, cap);

  onProgress?.({ message: `Pobieram ${limited.length} podstron...`, fetched: 0, total: limited.length });
  let fetchedCount = 0;
  const fetched = await mapWithConcurrency(limited, PAGE_FETCH_CONCURRENCY, async (url) => {
    try {
      const res = await safeFetch(url, { timeoutMs: PAGE_FETCH_TIMEOUT_MS });
      if (!res.ok) return null;
      const pageSignal = extractPageSignal(res.text);
      const label = pageSignal.title || pageSignal.h1 || labelFromUrlSlug(res.finalUrl);
      const signal = buildClusteringText(pageSignal) || label;
      return { url: res.finalUrl, label, signal } satisfies DiscoveredPage;
    } catch {
      return null;
    } finally {
      fetchedCount++;
      onProgress?.({
        message: `Pobrano ${fetchedCount}/${limited.length} podstron`,
        fetched: fetchedCount,
        total: limited.length,
      });
    }
  });

  const pages = fetched.filter((p): p is DiscoveredPage => p !== null);

  return {
    pages,
    discovered: pages.length,
    skipped: limited.length - pages.length,
    source,
  };
}
