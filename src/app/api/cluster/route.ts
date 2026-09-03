import { NextResponse } from "next/server";
import { isEmbeddingClusteringAvailable, EmbeddingClusteringUnavailableError } from "@/lib/embeddingClustering";
import { isSemanticClusteringAvailable, SemanticClusteringUnavailableError } from "@/lib/semanticClustering";
import { clusterPhrases, clusterSite, InvalidClusterInputError } from "@/lib/clusterService";
import { SsrfBlockedError } from "@/lib/urlSafety";
import { checkRateLimit, clientKeyFromRequest } from "@/lib/rateLimit";
import { type ClusterRequestBody, type ClusteringMethod, type CrawlStreamEvent } from "@/lib/types";

// Crawling a site (fetching robots.txt, a sitemap, and a batch of pages) can
// comfortably exceed the default serverless timeout on some hosts.
export const maxDuration = 60;

// Generous limit for normal interactive use of either mode.
const GENERAL_LIMIT = { max: 30, windowMs: 5 * 60_000 };
// Crawl mode fetches many external pages per call, and the embeddings/
// semantic methods call a paid API - all cost real money/bandwidth, so they
// share a stricter budget on top of the general one.
const EXPENSIVE_LIMIT = { max: 8, windowMs: 10 * 60_000 };

export async function GET() {
  // Embeddings and the semantic method are gated on the same credential
  // (OPENROUTER_API_KEY) - one flag covers both.
  return NextResponse.json({ aiAvailable: isSemanticClusteringAvailable() || isEmbeddingClusteringAvailable() });
}

function isKnownClusterError(error: unknown): error is Error {
  return (
    error instanceof SemanticClusteringUnavailableError ||
    error instanceof EmbeddingClusteringUnavailableError ||
    error instanceof SsrfBlockedError ||
    error instanceof InvalidClusterInputError
  );
}

export async function POST(request: Request) {
  let body: ClusterRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowy JSON w treści żądania." }, { status: 400 });
  }

  const method: ClusteringMethod =
    body.method === "semantic" || body.method === "embeddings" ? body.method : "lexical";
  const pageContext = typeof body.pageContext === "string" ? body.pageContext : undefined;
  const isExpensive = body.mode === "crawl" || method === "semantic" || method === "embeddings";

  const clientKey = clientKeyFromRequest(request);
  const general = checkRateLimit(`general:${clientKey}`, GENERAL_LIMIT.max, GENERAL_LIMIT.windowMs);
  const expensive = isExpensive
    ? checkRateLimit(`expensive:${clientKey}`, EXPENSIVE_LIMIT.max, EXPENSIVE_LIMIT.windowMs)
    : { allowed: true, retryAfterSeconds: 0 };

  if (!general.allowed || !expensive.allowed) {
    const retryAfterSeconds = Math.max(general.retryAfterSeconds, expensive.retryAfterSeconds);
    return NextResponse.json(
      { error: `Zbyt wiele żądań. Spróbuj ponownie za ${retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
    );
  }

  if (body.mode === "crawl") {
    return handleCrawlMode(body.siteUrl, method, pageContext);
  }

  try {
    const phrases = Array.isArray(body.phrases) ? body.phrases.filter((p): p is string => typeof p === "string") : [];
    const result = await clusterPhrases(phrases, method, pageContext);
    return NextResponse.json(result);
  } catch (error) {
    if (isKnownClusterError(error)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Cluster generation failed:", error);
    return NextResponse.json(
      { error: "Nie udało się wygenerować grupowania. Spróbuj ponownie." },
      { status: 500 },
    );
  }
}

// Crawl mode can take several seconds (robots.txt + sitemap/link discovery +
// N page fetches), so it streams newline-delimited progress events instead
// of making the client wait on one opaque request. The HTTP status is
// always 200 once the stream starts (it has to be - the status line is
// already sent); failures surface as a final { type: "error" } line instead.
function handleCrawlMode(
  siteUrl: unknown,
  method: ClusteringMethod,
  pageContext: string | undefined,
): Response {
  if (typeof siteUrl !== "string") {
    return NextResponse.json({ error: "Podaj URL strony głównej." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: CrawlStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await clusterSite(siteUrl, method, pageContext, (progress) => {
          send({ type: "status", message: progress.message, fetched: progress.fetched, total: progress.total });
        });
        send({ type: "done", result });
      } catch (error) {
        if (isKnownClusterError(error)) {
          send({ type: "error", message: error.message });
        } else {
          console.error("Cluster generation failed:", error);
          send({ type: "error", message: "Nie udało się wygenerować grupowania. Spróbuj ponownie." });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
