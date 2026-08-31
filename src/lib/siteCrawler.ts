import { safeFetch, assertPublicHttpUrl, SsrfBlockedError } from "./urlSafety";
import {
  extractLinks,
  extractPageSignal,
  labelFromUrlSlug,
  parseSitemapLocs,
  parseRobotsDisallow,
  isDisallowedByRobots,
  sitemapKind,
} from "./htmlParsing";

export interface DiscoveredPage {
  url: string;
  title: string;
}

export interface CrawlResult {
  pages: DiscoveredPage[];
  discovered: number;
  skipped: number;
  source: "sitemap" | "links";
}

const MAX_PAGES_FROM_SITEMAP = 80;
const MAX_PAGES_FROM_LINKS = 60;
const MAX_SUB_SITEMAPS = 3;
const PAGE_FETCH_CONCURRENCY = 6;
const PAGE_FETCH_TIMEOUT_MS = 6000;

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

async function collectLinksFromHomepage(origin: string, homepageHtml: string): Promise<string[]> {
  const links = extractLinks(homepageHtml, origin);
  const sameOrigin = links.filter((link) => new URL(link).origin === origin);
  return Array.from(new Set(sameOrigin));
}

export async function discoverPages(siteUrlInput: string): Promise<CrawlResult> {
  const validated = await assertPublicHttpUrl(siteUrlInput);
  const origin = validated.origin;

  const homepage = await safeFetch(origin, { timeoutMs: 8000 });
  if (!homepage.ok) {
    throw new SsrfBlockedError(`Nie udało się pobrać strony głównej (status ${homepage.status}).`);
  }

  const disallowRules = await fetchRobotsDisallowRules(origin);

  let candidateUrls = await collectSitemapUrls(origin);
  let source: CrawlResult["source"] = "sitemap";

  if (candidateUrls.length === 0) {
    candidateUrls = await collectLinksFromHomepage(origin, homepage.text);
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

  const fetched = await mapWithConcurrency(limited, PAGE_FETCH_CONCURRENCY, async (url) => {
    try {
      const res = await safeFetch(url, { timeoutMs: PAGE_FETCH_TIMEOUT_MS });
      if (!res.ok) return null;
      const { title, h1 } = extractPageSignal(res.text);
      const label = title || h1 || labelFromUrlSlug(res.finalUrl);
      return { url: res.finalUrl, title: label } satisfies DiscoveredPage;
    } catch {
      return null;
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
