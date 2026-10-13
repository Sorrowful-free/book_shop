# web

Nuxt 4 SSR storefront for the book shop (Vue 3 + Tailwind). Spec:
`docs/specs/06-web.md`. Talks to the outside world **only** through same-origin
`/api/*` calls — a BFF catch-all route (`server/api/[...].ts`) proxies them to
`{GATEWAY_URL}/api/v1/*`, forwards the client's `cookie` header and relays the
gateway's `set-cookie` headers back. JWTs live in httpOnly cookies only; no
token is ever readable from JS.

## Pages

| Route          | Content                                                       | Access          |
| -------------- | ------------------------------------------------------------- | --------------- |
| `/`            | Catalog grid, search (`?query=`), genre filter, `?page=` pager | public          |
| `/books/[id]`  | Book detail + add-to-cart                                     | public          |
| `/cart`        | Enriched positions, quantity edit, totals                     | public (guest)  |
| `/checkout`    | Cart summary → place order (idempotency key) → pay            | auth            |
| `/orders`      | Order history with status badges, inline pay/cancel           | auth            |
| `/login`       | Login form                                                    | guest           |
| `/register`    | Registration form                                             | guest           |
| `/admin/books` | Book CRUD table + modal; delete/restore are Admin-only        | Employer, Admin |

## Silent refresh

When the gateway answers `401` and the client holds a `refresh_token` cookie,
the proxy calls `POST /api/v1/auth/refresh` once, forwards the rotated
`set-cookie` headers to the browser and retries the original request once with
the merged cookie jar. A failed refresh returns the original `401`.

### SSR caveat

During SSR, `useFetch`/`useRequestFetch` calls hit the BFF route as internal
requests whose sub-responses are discarded — headers appended there never
reach the browser, and h3 does not share `event.context` between an outer
event and its internal sub-events. `app/plugins/session.ts` therefore fetches
`/api/auth/me` through `event.fetch` (raw `Response`), relays rotated
`set-cookie` headers onto the outer response and rewrites
`event.node.req.headers.cookie`, so every later SSR-internal call carries the
fresh pair. The same plugin skips `/api/auth/me` and `/api/cart` entirely when
the request has no relevant cookie, and `/cart` gates its SSR fetch the same
way — otherwise every anonymous pageview would mint an empty Redis guest cart
whose `set-cookie` is dropped. Residual gap: a page-level SSR fetch that
triggers a refresh by itself (access token dying mid-render) still drops the
rotated pair — effectively unreachable with hour-scale access TTLs.

## Env

See `.env.example`:

- `GATEWAY_URL` — api-gateway base URL (server-only, never exposed publicly)
- `NUXT_PORT`/`PORT` — dev-server port (default `3001`); the built nitro
  server reads `PORT`/`NITRO_PORT` (nitro default 3000)

## Run

```bash
bun install                                # repo root
bun --filter '@book-shop/web' dev          # http://localhost:3001
bun --filter '@book-shop/web' build        # production build → .output/
bun --filter '@book-shop/web' start        # serve the build (bun runtime)
bun --filter '@book-shop/web' typecheck    # nuxi prepare + vue-tsc
```

The app runs under **Bun** (this repo has no Node.js): scripts invoke the nuxt
CLI via `bunx --bun` so the `#!/usr/bin/env node` shebangs in package bins are
bypassed.

## Tests

Colocated `*.spec.ts` files cover only pure helpers (`app/utils/*`,
`server/utils/proxy.ts`) — they have no nuxt/`#imports` dependencies and run
under the repo-wide `bun test`.

`bun --filter @book-shop/web smoke` runs `test/bff-smoke.mjs` (not a spec
file): it boots `nuxt dev` against a stub gateway and asserts the SSR cookie
relay end-to-end — rotated `set-cookie` after silent refresh reaching the
browser, no anonymous guest-cart minting, login cookie relay.
