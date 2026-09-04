// In-memory, per-process rate limiting. This endpoint fetches arbitrary
// user-supplied URLs (crawl mode) and calls a paid LLM API (semantic
// method) - both cost real money and outbound requests per call, so an
// unlimited endpoint is an open cost/abuse spigot. Fixed-window counters
// keyed by client IP; good enough for a single-instance deployment. Behind
// a load balancer with multiple instances, each instance counts
// independently, so the effective limit is `limit x instanceCount` - swap
// this for a shared store (Redis, etc.) if that matters for your deployment.

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 20_000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    if (buckets.size > MAX_TRACKED_KEYS) evictExpired(now, windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.ceil((existing.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function evictExpired(now: number, windowMs: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= windowMs) buckets.delete(key);
  }
}

// Best-effort client identifier from standard proxy headers (set by
// Vercel, most reverse proxies, etc.). Falls back to a shared bucket when
// no proxy header is present, which still rate-limits *something* rather
// than silently exempting direct/unproxied traffic.
export function clientKeyFromRequest(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "unknown";
}
