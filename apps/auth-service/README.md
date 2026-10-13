# auth-service

Identity service — owns users and credentials, issues and verifies JWTs
(gRPC `:50051`, package `bookshop.auth.v1`). Spec: `docs/specs/01-auth-service.md`.

## RPCs

`Register`, `Login`, `Refresh` (jti rotation), `RevokeToken` (logout +
access-jti Redis denylist), `ValidateToken`, `GetUser` (ownership rules).
See `packages/contracts/proto/auth.proto`.

## Tokens

Both JWTs are EdDSA/Ed25519 with claims `{sub, user_name, role, jti, typ}`.
The `typ` claim is `"access"` or `"refresh"` and is enforced strictly:
`JwtVerifier` (all services) accepts only `typ="access"` — a refresh token
cannot be used as a bearer access token — and Refresh/RevokeToken require
`typ="refresh"`. Refresh rotation revokes atomically (`revoked_at IS NULL`
conditional update), so concurrent reuse of one refresh token can't mint
two pairs.

## Env

See `.env.example`. Ed25519 keys are base64-encoded PEM — generate a pair with:

```bash
bun run gen-keys
```

`JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` may also be supplied as files via
`JWT_PRIVATE_KEY_FILE`/`JWT_PUBLIC_KEY_FILE` (docker-secrets convention —
the file wins when both are set).

`refresh_tokens` are garbage-collected by a periodic sweeper: rows whose
`expires_at` is older than `REFRESH_TOKEN_AUDIT_TTL_SEC` (default 7 days)
are deleted every `REFRESH_TOKEN_SWEEP_INTERVAL_SEC` (default 1 hour).

## Run

```bash
bun run infra:up                       # postgres + redis + kafka
cd apps/auth-service
bun run db:deploy
bun run db:generate
bun run start
```

The admin user is seeded at startup from `SEED_ADMIN_*` env
(defaults `admin`/`admin`). An **employer** account can additionally be seeded
via `SEED_EMPLOYER_USER_NAME` + `SEED_EMPLOYER_PASSWORD` (spec 06) — there are
no defaults: when the name is unset, no employer is created; when it is set,
the password is required. Both seeds are idempotent (existing users are left
untouched). Registration events are published to Kafka
(`auth.user.events`, `auth.user.registered`) through the transactional
outbox (`outbox` table + `OutboxRelay`) — the service boots and serves
RPCs even when the broker is down.

## grpcurl

```bash
grpcurl -plaintext -d '{"user_name":"alice_01","password":"Str0ng!pass"}' \
  -import-path ../../packages/contracts/proto -proto auth.proto \
  localhost:50051 bookshop.auth.v1.AuthService/Register

grpcurl -plaintext -d '{"user_name":"admin","password":"admin"}' \
  -import-path ../../packages/contracts/proto -proto auth.proto \
  localhost:50051 bookshop.auth.v1.AuthService/Login
```
