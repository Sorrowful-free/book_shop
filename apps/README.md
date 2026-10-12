# apps

Deployable applications. Each app is implemented in its own plan via the
spec-driven workflow described in [AGENTS.md](../AGENTS.md) — spec first
(`docs/specs/`), contracts in `packages/contracts`, failing tests, then
implementation.

| App              | Stack              | Port  | Storage             | Status  |
| ---------------- | ------------------ | ----- | ------------------- | ------- |
| `web`            | Nuxt (Vue SSR)     | 3001  | —                   | planned |
| `api-gateway`    | NestJS (HTTP REST) | 3000  | Redis (denylist read) | planned |
| `auth-service`   | NestJS (gRPC)      | 50051 | PostgreSQL `auth_db` + Redis (denylist write) | planned |
| `catalog-service`| NestJS (gRPC)      | 50052 | PostgreSQL `catalog_db` + Redis (denylist read) | planned |
| `cart-service`   | NestJS (gRPC)      | 50053 | Redis (carts + denylist read) | planned |
| `order-service`  | NestJS (gRPC)      | 50054 | PostgreSQL `order_db` + Redis (denylist read) | planned |
