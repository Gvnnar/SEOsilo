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
}

// Best available label for a page: <title>, falling back to the first <h1>.
export function extractPageSignal(html: string): PageSignal {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim().replace(/\s+/g, " ");
  const h1 = $("h1").first().text().trim().replace(/\s+/g, " ");
  return { title, h1 };
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
