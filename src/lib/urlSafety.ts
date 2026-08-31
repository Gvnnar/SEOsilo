import dns from "node:dns/promises";
import net from "node:net";

export class SsrfBlockedError extends Error {}

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 3_000_000;
const USER_AGENT = "SEOsiloBot/1.0 (+site-silo-analysis)";

// IPv4 ranges that must never be reachable from a server-side fetch of a
// user-supplied URL: loopback, private, link-local (incl. the cloud
// metadata endpoint 169.254.169.254), CGNAT, and other reserved blocks.
function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 address - check the embedded IPv4 address.
    const mapped = normalized.split(":").pop()!;
    if (net.isIPv4(mapped)) return isPrivateOrReservedIpv4(mapped);
  }
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (fc00::/7)
  if (normalized === "::") return true;
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIpv6(ip);
  return true; // unrecognized format - fail closed
}

// Resolves the hostname and rejects any URL whose scheme isn't http(s) or
// that resolves (even partially) to a private/loopback/link-local address -
// the standard SSRF guard needed before a server fetches a user-given URL.
export async function assertPublicHttpUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfBlockedError("Nieprawidłowy URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError("Dozwolone są tylko adresy http:// i https://.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SsrfBlockedError("Adresy localhost są niedozwolone.");
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`Nie udało się rozwiązać adresu ${hostname}.`);
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new SsrfBlockedError(`Adres ${hostname} wskazuje na niedozwoloną sieć.`);
  }

  return url;
}

interface SafeFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  text: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

// fetch() with SSRF-safe URL validation on every hop (redirects are not
// auto-followed - each Location header is re-validated before following),
// a hard timeout, and a capped response body size.
export async function safeFetch(
  inputUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let currentUrl = await assertPublicHttpUrl(inputUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml,text/xml,*/*" },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, status: response.status, finalUrl: currentUrl.href, text: "" };
      const nextUrl = new URL(location, currentUrl);
      currentUrl = await assertPublicHttpUrl(nextUrl.href);
      continue;
    }

    const text = await readCapped(response, maxBytes);
    return { ok: response.ok, status: response.status, finalUrl: currentUrl.href, text };
  }

  throw new SsrfBlockedError("Zbyt wiele przekierowań.");
}
