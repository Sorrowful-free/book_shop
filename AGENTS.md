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

Every service/feature is implemented by a separate plan/subagent, in this order:

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
bun run test:e2e           # <app>/test/*.e2e.spec.ts — needs `infra:up`
bun run lint               # eslint
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

- Tests: `bun:test`, `*.spec.ts` colocated; e2e in `<app>/test/`.
  **Never `mock.module`** — `bun test` shares the module registry across
  files in one process, so a module mock leaks into unrelated specs. Use DI
  (e.g. `seedAdminUser`'s injected `hash`) or local spies/fakes instead
- Env: per-app `.env` (gitignored), commit `.env.example`. Every secret may
  be supplied as `<NAME>` or `<NAME>_FILE` (path to a file — docker-secrets
  convention); the file wins when both are set. Read them via
  `resolveSecret` from `@book-shop/common`, never `process.env` directly
- gRPC controllers: any handler taking `Metadata` MUST declare
  `@Ctx() metadata?: Metadata` explicitly — once a `@Payload` is decorated,
  undecorated parameters silently receive `undefined` (metadata lost →
  everything UNAUTHENTICATED). See controllers in existing services
- gRPC errors: throw `RpcException` via the local `rpcError` helper —
  `{ code, message }` payload **plus** the same `code` assigned top-level
  (grpc-js reads `error.code` when the exception escapes raw)
- Dependencies: add only via `bun add` — never hand-edit `bun.lock`
- Dev secrets in `infra/` are local-only, never reused in production
- No MongoDB anywhere — PostgreSQL (**Prisma** ORM) + Redis only
- e2e needing JWTs: tests generate an Ed25519 key pair with `jose` (or reuse
  auth-service `gen-keys`), inject `JWT_PUBLIC_KEY` into the service under
  test and sign test tokens directly — no auth-service dependency in tests
- Role seeding: only `admin` is seeded; tests needing other roles insert
  users directly into the DB (no role-management RPC by design)
