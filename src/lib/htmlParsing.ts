import * as cheerio from "cheerio";

const SKIPPED_EXTENSIONS = /\.(pdf|jpe?g|png|gif|svg|webp|zip|rar|mp4|mp3|css|js|xml|json|ico|woff2?)$/i;

// Every <a href> on the page, resolved to absolute http(s) URLs. Same-origin
// filtering and dedup happen in the caller, which already knows the origin.
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) return;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    if (SKIPPED_EXTENSIONS.test(resolved.pathname)) return;

    resolved.hash = "";
    links.push(resolved.href);
  });

  return links;
}

export interface PageSignal {
  title: string;
  h1: string;
  metaDescription: string;
  // <h1>-<h3> text, in document order, trimmed and deduplicated.
  headings: string[];
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Everything on the page worth analyzing beyond the bare title: meta
// description and the H1-H3 heading structure, which sketch what the page
// actually covers even when the <title> is generic or SEO-stuffed.
export function extractPageSignal(html: string): PageSignal {
  const $ = cheerio.load(html);
  const title = normalizeText($("title").first().text());
  const h1 = normalizeText($("h1").first().text());
  const metaDescription = normalizeText($('meta[name="description"]').first().attr("content") ?? "");

  const seen = new Set<string>();
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const text = normalizeText($(el).text());
    if (text && !seen.has(text)) {
      seen.add(text);
      headings.push(text);
    }
  });

  return { title, h1, metaDescription, headings };
}

const MAX_SIGNAL_CHARS = 500;

// Builds the compact per-page text actually used for clustering: title,
// meta description and heading structure joined on one line (never a raw
// newline - callers place this in a numbered list) and capped in length so
// one bloated page can't blow up the token cost of a whole crawl.
export function buildClusteringText(signal: PageSignal): string {
  const parts = [signal.title, signal.metaDescription, ...signal.headings]
    .map((p) => p.trim())
    .filter(Boolean);

  const deduped = Array.from(new Set(parts));
  const joined = deduped.join(" · ");
  return joined.length > MAX_SIGNAL_CHARS ? `${joined.slice(0, MAX_SIGNAL_CHARS)}…` : joined;
}

// Humanizes the last path segment of a URL into a readable label, used only
// when a page has neither <title> nor <h1>.
export function labelFromUrlSlug(url: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const segment = path.split("/").pop() ?? "";
  const cleaned = segment.replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
  return cleaned || url;
}

export type SitemapKind = "index" | "urlset" | "unknown";

export function sitemapKind(xml: string): SitemapKind {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($("sitemapindex").length > 0) return "index";
  if ($("urlset").length > 0) return "urlset";
  return "unknown";
}

// Every <loc> entry - works the same whether the document is a sitemap
// index (entries are sub-sitemap URLs) or a urlset (entries are page URLs);
// the caller decides which based on sitemapKind().
export function parseSitemapLocs(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs: string[] = [];
  $("loc").each((_, el) => {
    const text = $(el).text().trim();
    if (text) locs.push(text);
  });
  return locs;
}

// Simplified robots.txt parser: collects Disallow prefixes for the User-agent: *
// block(s). Good enough to keep the crawler off obviously-excluded paths
// (/admin, /cart, ...) - not a full RFC 9309 implementation (no Allow
// overrides, no wildcard/$ matching).
export function parseRobotsDisallow(robotsTxt: string): string[] {
  const lines = robotsTxt.split(/\r?\n/).map((line) => line.split("#")[0].trim());
  const disallowed = new Set<string>();
  let inWildcardBlock = false;

  for (const line of lines) {
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inWildcardBlock = value === "*";
    } else if (key === "disallow" && inWildcardBlock && value) {
      disallowed.add(value);
    }
  }

  return Array.from(disallowed);
}

export function isDisallowedByRobots(pathname: string, disallowRules: string[]): boolean {
  return disallowRules.some((rule) => pathname.startsWith(rule));
}
