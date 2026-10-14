# AGENTS

Guidelines for AI agents working in this repository.

## What this is

Book shop — educational microservices showcase. Monorepo on **Bun workspaces**:

- `apps/` — deployable apps: `web` (Nuxt SSR), `api-gateway` (NestJS HTTP :3000),
  `auth-service`/`catalog-service`/`cart-service`/`order-service` (NestJS gRPC :50051–50054)
- `packages/contracts` — protobuf files + generated stubs (ts-proto), Kafka topics + event payloads, shared types (UserRole)
- `packages/common` — runtime helpers: `JwtVerifier` (EdDSA + denylist), `OutboxRelay` + shared `PrismaOutboxStore`/`KafkaEventPublisher` implementations, gRPC metadata helpers
- `infra/` — docker-compose: PostgreSQL (per-service DBs: `auth_db`, `catalog_db`, `order_db`), Redis (cart), Kafka (KRaft)
- `docs/specs/` — service specs, template: `docs/specs/_template.md`

## Communication

- Sync calls between services: **gRPC** (`@nestjs/microservices` + `@grpc/grpc-js`).
  Proto contracts live in `packages/contracts/proto`; TypeScript stubs are
  **codegenerated with buf + ts-proto** (`bun run proto:gen`) — no runtime
  proto loading
- Async domain events: **Kafka** (topics `auth.user.events`, `catalog.book.events`,
  `order.order.events` — see `contracts/src/topics.ts`). Delivery is via
  **transactional outbox**: mutation + `outbox` row in one DB transaction,
  `OutboxRelay` (from `@book-shop/common`) publishes at-least-once.
  Consumers MUST be idempotent
- Auth (defense in depth): every service verifies JWT itself — raw token in
  `authorization` gRPC metadata, EdDSA public key via `JwtVerifier`
  (`@book-shop/common`). Revoked token jtis live in a Redis denylist
  (`auth:revoked:{jti}`, TTL = token exp) checked by the verifier — access
  tokens without `jti` are rejected (they would be unrevocable).
  Service-to-service calls propagate `authorization`; `x-user-*` metadata
  fields are NOT used/trusted. Ownership checks are done in the owning
  service; role matrix additionally enforced at api-gateway

## Runtime portability (hard rule)

Application code (`src/` of every app and all of `packages/`) MUST run under
**both Bun and Node.js LTS**. Bun is the dev toolchain only (install, test
runner, scripts) — never a runtime dependency.

- No `Bun.*` globals (`Bun.password`, `Bun.sql`, `Bun.file`, `Bun.serve`, …)
- No `bun:*` module imports in application code
- No Bun-specific dependency APIs — prefer portable libraries
  (e.g. `@node-rs/argon2` instead of `Bun.password`, `postgres.js`-compatible
  drivers instead of `Bun.sql`)
- Allowed exception: test files (`*.spec.ts`, `test/`) may import `bun:test`

Enforced by eslint (`no-restricted-globals`, `no-restricted-imports`) — CI fails
on violations.

## Spec-driven workflow (mandatory)

Every service/feature is implemented by a separate plan/subagent. Background
subagents run with exec auto-denied — they can write files but cannot run
verification; dispatch implementation plans to a foreground
`subagent_general`, or plan to run tests/builds/docker in the parent after
the background agent reports.

In this order:

1. **Spec** — `docs/specs/NN-<name>.md` from `_template.md`, reviewed/approved
2. **Contracts first** — proto/event changes land in `packages/contracts` before code
3. **Tests first** — unit + e2e tests from the spec, failing (`bun test`)
4. **Implementation last** — until tests are green
5. **Commit per plan** — each plan/subagent lands as its own commit(s);
   no mixing plans in one working-tree dump
6. **DoD** — tests green, spec + README updated, service runs against `infra/`

## Commands

```bash
bun install                # all workspaces
bun run infra:up           # postgres + redis + kafka + kafka-ui
bun test                   # all tests (bun test, colocated *.spec.ts + test/)
bun run test:unit          # colocated *.spec.ts only — no infra needed
bun run test:e2e           # <app>/test/*.e2e.spec.ts — needs `infra:up` incl. minio
bun run lint               # eslint
bun run lint:fix           # eslint --fix (prettier included) — run on
                           # touched files before reporting
bun run typecheck          # tsc --noEmit per workspace
bun run proto:lint         # buf lint packages/contracts (needs buf CLI)
bun run db:generate        # prisma generate for every DB-backed service
                           # (per-service output in src/generated/prisma —
                           #  required before typecheck/tests)
```

## Git

- Only the user commits. The agent never runs `git commit`, `git rebase`, or
  `git push` — it stages/prepares changes and reports; the user reviews and
  commits. Exception: an explicit user request for a specific commit.
- Commit messages: no tool attribution (no "Generated with", no Co-Authored-By
  trailers), lowercase, one long descriptive subject line — match `git log`.

## Conventions

Code conventions live in `docs/CONVENTIONS.md` — read it before writing
code or tests in any app or package (test placement, env/secrets, gRPC
handler signatures, dependency rules, web styling). New conventions go
there, not here — keep this file to hard rules and pointers.
