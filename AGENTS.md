# AGENTS

Guidelines for AI agents working in this repository.

## What this is

Book shop — educational microservices showcase. Monorepo on **Bun workspaces**:

- `apps/` — deployable apps: `web` (Nuxt SSR), `api-gateway` (NestJS HTTP :3000),
  `auth-service`/`catalog-service`/`cart-service`/`order-service` (NestJS gRPC :50051–50054)
- `packages/contracts` — protobuf files, Kafka topics + event payloads, shared types (UserRole)
- `packages/common` — runtime helpers (gRPC metadata user-context, roles)
- `infra/` — docker-compose: PostgreSQL (per-service DBs: `auth_db`, `catalog_db`, `order_db`), Redis (cart), Kafka (KRaft)
- `docs/specs/` — service specs, template: `docs/specs/_template.md`

## Communication

- Sync calls between services: **gRPC** (`@nestjs/microservices` + `@grpc/grpc-js`,
  proto loaded at runtime from `packages/contracts/proto`)
- Async domain events: **Kafka** (topics `auth.user.events`, `catalog.book.events`,
  `order.order.events` — see `contracts/src/topics.ts`)
- Auth: JWT verified **only at api-gateway**; user context propagates to services
  via gRPC metadata keys (`x-user-id`, `x-user-name`, `x-user-role` — see
  `common/src/user-context.ts`)

## Spec-driven workflow (mandatory)

Every service/feature is implemented by a separate plan/subagent, in this order:

1. **Spec** — `docs/specs/NN-<name>.md` from `_template.md`, reviewed/approved
2. **Contracts first** — proto/event changes land in `packages/contracts` before code
3. **Tests first** — unit + e2e tests from the spec, failing (`bun test`)
4. **Implementation last** — until tests are green
5. **DoD** — tests green, spec + README updated, service runs against `infra/`

## Commands

```bash
bun install                # all workspaces
bun run infra:up           # postgres + redis + kafka + kafka-ui
bun test                   # all tests (bun test, colocated *.spec.ts + test/)
bun run lint               # eslint
bun run typecheck          # tsc --noEmit per workspace
bun run proto:lint         # buf lint packages/contracts (needs buf CLI)
```

## Conventions

- Tests: `bun:test`, `*.spec.ts` colocated; e2e in `<app>/test/`
- Env: per-app `.env` (gitignored), commit `.env.example`
- Dev secrets in `infra/` are local-only, never reused in production
- No MongoDB anywhere — PostgreSQL (Drizzle ORM recommended) + Redis only
