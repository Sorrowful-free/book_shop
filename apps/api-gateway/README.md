# api-gateway

Single HTTP entry point — NestJS (express) on `:3000`, global prefix
`/api/v1`. Spec: [`docs/specs/05-api-gateway.md`](../../docs/specs/05-api-gateway.md).

- **JWT** — EdDSA verified locally (`JwtVerifier` + `RedisTokenDenylist`
  reads `auth:revoked:{jti}` — read-only, auth-service is the writer).
  Token source: `access_token` httpOnly cookie OR `Authorization: Bearer`
  (Bearer wins when both are present). The raw JWT is forwarded to
  upstreams as `authorization` gRPC metadata — services re-verify
  themselves; `x-user-*` is never propagated. `x-trace-id` is forwarded
  (or generated per request).
- **Cookies** — `access_token`, `refresh_token`, `cart_id`: httpOnly,
  SameSite=Lax, Path=/, `Secure` via `COOKIE_SECURE`. login/register set
  the pair AND return tokens in the body (API-client mode); a guest
  `cart_id` cookie is merged into the user cart via `cart.MergeCart`
  and cleared.
- **Role matrix** — enforced at the gateway first (spec §2): book
  create/update EMPLOYER|ADMIN, delete/restore ADMIN; orders need any
  authenticated user.
- **Cart** — guests get a service-issued `cart_id` cookie on first touch
  (`CreateCart`); authenticated requests ignore the cookie. Responses are
  enriched with catalog `bookName`/`author`/`price`/`available` — a gone
  book degrades a position to `available: false` instead of failing the
  request (the catalog `GetBooksByIds` NOT_FOUND is retried per-book).
- **Errors** — gRPC codes map to HTTP per spec §6 (e.g. NOT_FOUND→404,
  UNAVAILABLE→503); every failure body is `{ statusCode, message, error }`.
- **Docs** — Swagger UI on `/api/docs` (outside the global prefix);
  `/api/docs-json` serves the OpenAPI document.
- **Proxying details** — `POST /orders/checkout` forwards the
  `Idempotency-Key` header (or generates a uuid per request); `POST
  /auth/logout` clears cookies even when `RevokeToken` fails (204); a
  missing refresh credential is 400, a revoked one is 401.

## Run

```bash
cp .env.example .env   # set JWT_PUBLIC_KEY (same Ed25519 key as auth-service)
bun run infra:up       # redis (denylist) + upstream services on :50051-50054
bun run start          # HTTP :3000
```

## Test

```bash
bun test src                      # unit (guards, cookies, error map, enrich)
bun test test/gateway.e2e.spec.ts # e2e — needs redis :6379; upstreams are
                                  # in-process gRPC stubs, no services needed
```

Env vars: `PORT`, `JWT_PUBLIC_KEY` (or `JWT_PUBLIC_KEY_FILE` — the file
wins), `REDIS_URL`, `AUTH_GRPC_ADDR`, `CATALOG_GRPC_ADDR`,
`CART_GRPC_ADDR`, `ORDER_GRPC_ADDR`, `COOKIE_SECURE`, `CORS_ORIGIN` —
see [`.env.example`](./.env.example).
