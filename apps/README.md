# apps

Deployable applications. Each app is implemented in its own plan via the
spec-driven workflow described in [AGENTS.md](../AGENTS.md) — spec first
(`docs/specs/`), contracts in `packages/contracts`, failing tests, then
implementation.

| App              | Stack              | Port  | Storage             | Status  |
| ---------------- | ------------------ | ----- | ------------------- | ------- |
| `web`            | Nuxt (Vue SSR)     | 3001  | —                   | implemented |
| `api-gateway`    | NestJS (HTTP REST) | 3000  | Redis (denylist read) | implemented |
| `auth-service`   | NestJS (gRPC)      | 50051 | PostgreSQL `auth_db` + Redis (denylist write) | implemented |
| `catalog-service`| NestJS (gRPC)      | 50052 | PostgreSQL `catalog_db` + Redis (denylist read) | implemented |
| `cart-service`   | NestJS (gRPC)      | 50053 | Redis (carts + denylist read) | implemented |
| `order-service`  | NestJS (gRPC)      | 50054 | PostgreSQL `order_db` + Redis (denylist read) | implemented |
