import {
  hasCookie,
  mergeCookies,
  responseCookies
} from "../../server/utils/proxy";
import type { RestUser } from "../utils/api";

/**
 * Populate the session state once per SSR render so every page renders
 * auth-aware markup without waiting for a client-side fetch.
 *
 * SSR-internal API calls are single-shot and their responses are
 * discarded — that has two consequences handled here:
 *
 *  - a `GET /api/cart` from a visitor with NO cookies would mint an empty
 *    Redis guest cart whose `set-cookie` never reaches the browser — so
 *    auth/cart are only probed when the request already carries a
 *    relevant cookie;
 *  - a silent refresh inside the proxy returns rotated tokens on the
 *    sub-response — relay them to the browser via `appendResponseHeader`
 *    on the outer event and fold them into the request's cookie jar so
 *    later SSR fetches (cart below, page-level useFetch) see the fresh
 *    access token.
 */
export default defineNuxtPlugin(async () => {
  const { user, cart } = useSession();
  const event = useRequestEvent();
  // useRequestFetch() (event.$fetch) forwards the incoming cookie header
  const requestFetch = useRequestFetch();

  const cookie = useRequestHeader("cookie") ?? "";
  const mayHaveSession =
    hasCookie(cookie, "access_token") || hasCookie(cookie, "refresh_token");

  if (event && mayHaveSession) {
    try {
      // event.fetch returns the raw Response so rotated session cookies
      // coming back from a silent refresh stay readable.
      const res = await event.fetch("/api/auth/me");
      const rotated = responseCookies(res);
      if (rotated.length > 0) {
        const { appendResponseHeader } = await import("h3");
        for (const c of rotated) {
          appendResponseHeader(event, "set-cookie", c);
        }
      }
      if (rotated.length > 0) {
        event.node.req.headers.cookie = mergeCookies(cookie, rotated);
      }
      user.value = res.ok ? ((await res.json()) as RestUser) : null;
    } catch {
      user.value = null;
    }
  }

  if (user.value !== null || hasCookie(cookie, "cart_id")) {
    try {
      cart.value = await requestFetch("/api/cart");
    } catch {
      cart.value = null;
    }
  }
});
