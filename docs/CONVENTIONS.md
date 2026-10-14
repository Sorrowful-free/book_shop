# Conventions

Code and testing conventions for this repo. Cheap rules are enforced
mechanically (eslint, `test/style-guard.spec.ts`) — the rest hold by
review. Add new conventions here, not in `AGENTS.md`.

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
- Literals shared across a service boundary (regex, mime lists, path
  prefixes) live in `packages/contracts/src` — not as per-service copies
  that drift (e.g. `covers.ts`: `COVER_KEY_PATTERN`, `COVER_CONTENT_TYPES`)
- Dev secrets in `infra/` are local-only, never reused in production
- Docker/CI: one-shot compose services (init containers like `kafka-init`,
  `minio-init`) must stay out of `docker compose up --wait` — if one exits
  before compose's first status poll, `--wait` fails with
  `container ... exited (0)` despite success. Start them detached, then
  block with `docker compose wait`, which returns real exit codes
- No MongoDB anywhere — PostgreSQL (**Prisma** ORM) + Redis only
- e2e needing JWTs: tests generate an Ed25519 key pair with `jose` (or reuse
  auth-service `gen-keys`), inject `JWT_PUBLIC_KEY` into the service under
  test and sign test tokens directly — no auth-service dependency in tests
- Role seeding: `SEED_ADMIN_*` seeds `admin` (defaults admin/admin), plus an
  optional employer via `SEED_EMPLOYER_USER_NAME`/`SEED_EMPLOYER_PASSWORD`;
  tests needing other roles insert users directly into the DB (no
  role-management RPC by design)
- Web (`apps/web`): logic worth unit-testing lives in pure functions under
  `app/utils/`/`server/utils/` — composables, pages and components stay
  thin because Nuxt auto-imports (`useState`, `useFetch`, `useRoute`) are
  unreachable from `bun test`. Styling uses the semantic tokens and
  component classes from spec 09 only; `test/style-guard.spec.ts` fails on
  raw palette literals — conscious exceptions go into its `ALLOWLIST`.
