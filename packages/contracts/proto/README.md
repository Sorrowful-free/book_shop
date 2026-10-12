# proto

gRPC service contracts (`*.proto`) live here, one file per service:

- `auth.proto` — added by the auth-service plan
- `catalog.proto` — added by the catalog-service plan
- `cart.proto` — added by the cart-service plan
- `order.proto` — added by the order-service plan

Rules:

- Contract changes land **before** the service implementation (spec-driven).
- TypeScript stubs are **codegenerated** — `bun run proto:gen`
  (buf + `ts-proto`, `nestJs=true`) into `src/gen/`, committed output or
  generated on install (decided by the first service plan).
- Lint with `bun run proto:lint` (requires `buf` CLI); `buf breaking` in CI
  guards compatibility.
- Use package `bookshop.<service>.v1` and keep field numbers stable.
