# proto

gRPC service contracts (`*.proto`) live here, one file per service:

- `auth.proto` — added by the auth-service plan
- `catalog.proto` — added by the catalog-service plan
- `cart.proto` — added by the cart-service plan
- `order.proto` — added by the order-service plan

Rules:

- Contract changes land **before** the service implementation (spec-driven).
- Proto files are loaded at runtime via `@grpc/proto-loader` — no codegen.
- Lint with `bun run proto:lint` (requires `buf` CLI).
- Use package `bookshop.<service>.v1` and keep field numbers stable.
