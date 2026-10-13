/**
 * BFF smoke test (regression net for the SSR cookie relay).
 *
 * Boots `nuxt dev` against a stub api-gateway and asserts the behavior fixed
 * in `app/plugins/session.ts` + `server/api/[...].ts`:
 *
 *  1. GET /orders with a dead access token: the BFF silently refreshes, the
 *     rotated set-cookie pair reaches the OUTER response, and the plugin
 *     rewrites the request cookie jar so later SSR fetches (cart, orders)
 *     reach the gateway with the fresh access token.
 *  2. Anonymous GET /cart sets no cookies and never touches the gateway
 *     cart endpoint (otherwise every pageview would mint an empty Redis
 *     guest cart whose set-cookie is discarded with the sub-response).
 *  3. POST /api/auth/login relays the gateway set-cookie pair verbatim.
 *
 * Deliberately NOT a *.spec.* file so `bun test` does not pick it up; it
 * manages real servers. Run via `bun --filter @book-shop/web smoke`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const GATEWAY_PORT = 3999;
const WEB_PORT = 3998;
const BASE = `http://localhost:${WEB_PORT}`;
const READY_TIMEOUT_MS = 120_000;

const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** set-cookie readers: Headers.get joins multiples, so prefer getSetCookie. */
function setCookies(res) {
  const headers = res.headers;
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single
    ? single.split(/,(?=\s*[^;,\s]+=)/).map((cookie) => cookie.trim())
    : [];
}

// ---------------------------------------------------------------------------
// Stub api-gateway: minimal /api/v1 surface + a request log for assertions.
// ---------------------------------------------------------------------------

const gatewayLog = [];

function json(body, status = 200, extraHeaders = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of extraHeaders) {
    headers.append(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const SESSION_COOKIE = "access_token=fresh; Path=/; HttpOnly; SameSite=Lax";

const gateway = Bun.serve({
  port: GATEWAY_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const cookie = req.headers.get("cookie") ?? "";
    gatewayLog.push({ method: req.method, path: url.pathname, cookie });

    if (url.pathname === "/api/v1/auth/me") {
      if (cookie.includes("access_token=fresh")) {
        return json({ userId: "u1", userName: "alice", role: "CUSTOMER" });
      }
      return json(
        { statusCode: 401, message: "unauthorized", error: "Unauthorized" },
        401
      );
    }
    if (url.pathname === "/api/v1/auth/login") {
      return json(
        { userId: "u1", userName: "alice", role: "CUSTOMER" },
        200,
        [
          ["set-cookie", SESSION_COOKIE],
          ["set-cookie", "refresh_token=r1; Path=/; HttpOnly; SameSite=Lax"]
        ]
      );
    }
    if (url.pathname === "/api/v1/auth/refresh") {
      if (cookie.includes("refresh_token")) {
        return json(
          { accessToken: "fresh", refreshToken: "r2" },
          200,
          [
            ["set-cookie", SESSION_COOKIE],
            ["set-cookie", "refresh_token=r2; Path=/; HttpOnly; SameSite=Lax"]
          ]
        );
      }
      return json({ statusCode: 401, message: "no refresh token" }, 401);
    }
    if (url.pathname === "/api/v1/orders") {
      return json({ orders: [], total: 0 });
    }
    if (url.pathname === "/api/v1/cart") {
      return json({ items: [] }, 200, [
        ["set-cookie", "cart_id=ssr-cart-9; Path=/; HttpOnly; SameSite=Lax"]
      ]);
    }
    if (url.pathname === "/api/v1/books") {
      return json({ books: [], total: 0 });
    }
    return json({});
  }
});

// ---------------------------------------------------------------------------
// nuxt dev, spawned in its own process group so cleanup can kill the tree.
// ---------------------------------------------------------------------------

const dev = Bun.spawn(
  ["setsid", "bun", "--filter", "@book-shop/web", "dev"],
  {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      PORT: String(WEB_PORT),
      NUXT_PORT: String(WEB_PORT)
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  }
);

const devOutput = [];
async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    devOutput.push(decoder.decode(value));
  }
}
drain(dev.stdout);
drain(dev.stderr);

function killDev() {
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    try {
      dev.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
process.on("exit", killDev);

function dumpDevLog() {
  const tail = devOutput.join("").split("\n").slice(-40).join("\n");
  console.error(`--- nuxt dev log (tail) ---\n${tail}\n---`);
}

async function waitForDev() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, {
        signal: AbortSignal.timeout(15_000)
      });
      await res.arrayBuffer();
      // `/` SSR-fetches /api/books through the BFF: once the stub sees
      // /api/v1/books, real routes are live AND the dev server picked up
      // GATEWAY_URL. Any earlier 200/503 is the "dev server starting"
      // placeholder or a stale process bound to the port.
      if (gatewayLog.some((e) => e.path === "/api/v1/books")) {
        return true;
      }
    } catch {
      // connection refused while the listener is coming up
    }
    if (dev.exitCode !== null) {
      return false;
    }
    await Bun.sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

try {
  console.log(`stub gateway on :${GATEWAY_PORT}, nuxt dev on :${WEB_PORT}`);
  const ready = await waitForDev();
  check("nuxt dev proxies to the stub gateway", ready);
  if (!ready) {
    dumpDevLog();
    throw new Error("dev server never reached the stub gateway");
  }

  console.log("[1] GET /orders with dead access token + refresh_token");
  const mark1 = gatewayLog.length;
  const res1 = await fetch(`${BASE}/orders`, {
    headers: { cookie: "access_token=dead; refresh_token=r1" },
    redirect: "manual"
  });
  await res1.arrayBuffer();
  check("orders page renders (200)", res1.status === 200, `got ${res1.status}`);
  const sc1 = setCookies(res1);
  check(
    "rotated access_token on outer response",
    sc1.some((c) => c.startsWith("access_token=fresh")),
    JSON.stringify(sc1)
  );
  check(
    "rotated refresh_token on outer response",
    sc1.some((c) => c.startsWith("refresh_token=r2")),
    JSON.stringify(sc1)
  );
  const log1 = gatewayLog.slice(mark1);
  const refreshIdx = log1.findIndex((e) => e.path === "/api/v1/auth/refresh");
  check("gateway saw the silent refresh", refreshIdx >= 0, JSON.stringify(log1));
  const afterRefresh = log1.slice(Math.max(refreshIdx, 0) + 1);
  check(
    "/api/v1/cart carries the fresh access token",
    afterRefresh.some(
      (e) => e.path === "/api/v1/cart" && e.cookie.includes("access_token=fresh")
    ),
    JSON.stringify(log1)
  );
  check(
    "/api/v1/orders carries the fresh access token",
    afterRefresh.some(
      (e) =>
        e.path === "/api/v1/orders" && e.cookie.includes("access_token=fresh")
    ),
    JSON.stringify(log1)
  );

  console.log("[2] anonymous GET /cart");
  const mark2 = gatewayLog.length;
  const res2 = await fetch(`${BASE}/cart`, { redirect: "manual" });
  await res2.arrayBuffer();
  check("cart page renders (200)", res2.status === 200, `got ${res2.status}`);
  check(
    "no set-cookie on the outer response",
    setCookies(res2).length === 0,
    JSON.stringify(setCookies(res2))
  );
  const log2 = gatewayLog.slice(mark2);
  check(
    "gateway saw zero /api/v1/cart calls",
    !log2.some((e) => e.path === "/api/v1/cart"),
    JSON.stringify(log2)
  );

  console.log("[3] POST /api/auth/login relays set-cookie");
  const res3 = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userName: "alice", password: "pw" })
  });
  await res3.arrayBuffer();
  check("login returns 200", res3.status === 200, `got ${res3.status}`);
  const sc3 = setCookies(res3);
  check(
    "login relays access_token",
    sc3.some((c) => c.startsWith("access_token=fresh")),
    JSON.stringify(sc3)
  );
  check(
    "login relays refresh_token",
    sc3.some((c) => c.startsWith("refresh_token=r1")),
    JSON.stringify(sc3)
  );
} catch (e) {
  failures.push(`exception: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  killDev();
  gateway.stop(true);
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAIL (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nBFF smoke: all assertions passed");
