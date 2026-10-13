/**
 * BFF catch-all proxy (spec 06 §3): every same-origin `/api/**` call is
 * forwarded to `{GATEWAY_URL}/api/v1/**` with the client's `cookie` header,
 * and the gateway's `set-cookie` headers are relayed back untouched —
 * tokens stay httpOnly and never reach JS.
 *
 * Silent refresh: when the gateway answers 401 and the client holds a
 * `refresh_token` cookie, the proxy calls `POST /auth/refresh` once, relays
 * the rotated `set-cookie` headers to the browser, then retries the original
 * request once with the merged cookie jar. A failed refresh yields the
 * original 401 untouched.
 */

import {
  appendResponseHeader,
  defineEventHandler,
  getHeader,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseStatus
} from "h3";
import {
  mapProxyPath,
  mergeCookies,
  PROXY_REQUEST_HEADERS,
  responseCookies,
  shouldAttemptRefresh
} from "../utils/proxy";

const BODILESS_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

function gatewayBase(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "");
}

function requestHeaders(
  event: Parameters<typeof getHeader>[0]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = getHeader(event, name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

function getSetCookies(res: Response): string[] {
  return responseCookies(res);
}

function forwardSetCookies(
  event: Parameters<typeof setResponseStatus>[0],
  cookies: string[]
): void {
  // NOTE: on SSR-internal calls (useFetch/event.$fetch during page render)
  // this appends to the sub-response, which is discarded — the session
  // plugin relays set-cookie explicitly for its own calls.
  for (const cookie of cookies) {
    appendResponseHeader(event, "set-cookie", cookie);
  }
}

async function callGateway(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined
): Promise<Response | undefined> {
  try {
    return await fetch(url, { method, headers, body, redirect: "manual" });
  } catch {
    return undefined;
  }
}

/** Copy status + content-type + set-cookie, then hand the raw body back. */
async function relay(
  event: Parameters<typeof setResponseStatus>[0],
  res: Response
): Promise<Uint8Array> {
  setResponseStatus(event, res.status);
  const contentType = res.headers.get("content-type");
  if (contentType) {
    event.node.res.setHeader("content-type", contentType);
  }
  forwardSetCookies(event, getSetCookies(res));
  return new Uint8Array(await res.arrayBuffer());
}

export default defineEventHandler(async (event) => {
  const gatewayUrl = useRuntimeConfig(event).gatewayUrl as string;
  const url = getRequestURL(event);
  const method = getMethod(event);
  const cookie = getHeader(event, "cookie");
  const headers = requestHeaders(event);
  const body = BODILESS_METHODS.has(method)
    ? undefined
    : ((await readRawBody(event)) ?? undefined);
  const target = mapProxyPath(gatewayUrl, url.pathname, url.search);

  let res = await callGateway(target, method, headers, body);
  if (!res) {
    setResponseStatus(event, 503);
    return {
      statusCode: 503,
      message: "api-gateway unreachable",
      error: "Service Unavailable"
    };
  }

  if (shouldAttemptRefresh(res.status, cookie, url.pathname)) {
    const refresh = await callGateway(
      `${gatewayBase(gatewayUrl)}/api/v1/auth/refresh`,
      "POST",
      cookie ? { cookie } : {},
      undefined
    );
    if (refresh && refresh.ok) {
      const rotated = getSetCookies(refresh);
      // rotated pair goes to the browser AND into the retry's cookie jar
      forwardSetCookies(event, rotated);
      headers.cookie = mergeCookies(cookie, rotated);
      await refresh.arrayBuffer(); // drain before reusing the connection
      const retried = await callGateway(target, method, headers, body);
      if (retried) {
        res = retried;
      }
    } else if (refresh) {
      await refresh.arrayBuffer().catch(() => undefined);
    }
    // refresh missing/401/failed → fall through with the original 401
  }

  return relay(event, res);
});
