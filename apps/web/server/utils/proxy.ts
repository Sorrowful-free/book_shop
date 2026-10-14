/**
 * Pure BFF-proxy decision logic — deliberately free of h3/nuxt imports so
 * `bun test` can exercise it raw (server/utils/proxy.spec.ts).
 */

/**
 * Read all `set-cookie` headers off a fetch Response — `Headers.get` joins
 * multiples into one comma-separated string, so prefer `getSetCookie` and
 * fall back to a comma-aware split (Expires= contains a comma).
 */
export function responseCookies(res: { headers: Headers }): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single
    ? single.split(/,(?=\s*[^;,\s]+=)/).map((cookie) => cookie.trim())
    : [];
}

/**
 * Request headers forwarded to the gateway. `cookie` carries the httpOnly
 * session/guest-cart state; `idempotency-key` is needed by checkout.
 */
export const PROXY_REQUEST_HEADERS = [
  "cookie",
  "content-type",
  "accept",
  "idempotency-key",
  "x-trace-id"
] as const;

/**
 * Gateway response headers the BFF copies verbatim onto the client
 * response (set-cookie is appended separately — it is multi-valued).
 * `content-type` keeps the body decodable; `content-length` +
 * `cache-control` preserve the immutable-cover caching contract
 * (`Cache-Control: public, max-age=31536000, immutable`, spec 08 §5/§10)
 * through the proxy instead of dropping it on the floor.
 */
export const PROXY_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control"
] as const;

/**
 * [name, value] pairs from PROXY_RESPONSE_HEADERS that the upstream
 * response actually carries — the caller setHeader()s each onto the
 * h3 event's raw response.
 */
export function relayResponseHeaders(res: {
  headers: Headers;
}): [string, string][] {
  const out: [string, string][] = [];
  for (const name of PROXY_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) {
      out.push([name, value]);
    }
  }
  return out;
}

/**
 * Map a same-origin web path onto the gateway URL:
 * `/api/books?limit=2` → `{GATEWAY_URL}/api/v1/books?limit=2`
 * (client `/api/*` ↔ gateway global prefix `/api/v1`, spec 06 §3 / spec 05 §2).
 */
export function mapProxyPath(
  gatewayUrl: string,
  apiPath: string,
  search = ""
): string {
  const base = gatewayUrl.replace(/\/+$/, "");
  // Already-versioned paths pass through unchanged: backend-issued cover
  // URLs are `/api/v1/covers/<key>` (spec 08 §6) — re-prefixing would yield
  // /api/v1/v1/... and break every <img> pointing at them.
  if (apiPath.startsWith("/api/v1/")) {
    return `${base}${apiPath}${search}`;
  }
  const sub = apiPath.replace(/^\/api\/?/, "");
  return `${base}/api/v1/${sub}${search}`;
}

/** Does a `cookie` request header contain `name`? */
export function hasCookie(
  cookieHeader: string | null | undefined,
  name: string
): boolean {
  if (!cookieHeader) {
    return false;
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return true;
    }
  }
  return false;
}

/**
 * Silent-refresh decision (spec 06 §3): only a 401 accompanied by a
 * `refresh_token` cookie justifies one refresh + one retry. `auth/refresh`
 * itself is excluded — a nested refresh attempt would double-rotate the
 * token pair and recurse pointlessly.
 */
export function shouldAttemptRefresh(
  status: number,
  cookieHeader: string | null | undefined,
  apiPath: string
): boolean {
  if (status !== 401) {
    return false;
  }
  if (apiPath.replace(/^\/api\/?/, "") === "auth/refresh") {
    return false;
  }
  return hasCookie(cookieHeader, "refresh_token");
}

/**
 * Fold a batch of `set-cookie` response headers into a request `cookie`
 * header — used to retry the original call with the rotated token pair the
 * gateway just issued. An empty `name=` value (cookie being cleared) removes
 * the entry from the jar.
 */
export function mergeCookies(
  cookieHeader: string | null | undefined,
  setCookies: string[]
): string {
  const jar = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name) {
      jar.set(name, part.slice(eq + 1).trim());
    }
  }
  for (const setCookie of setCookies) {
    const semi = setCookie.indexOf(";");
    const pair = (semi === -1 ? setCookie : setCookie.slice(0, semi)).trim();
    const eq = pair.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    if (value === "") {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
