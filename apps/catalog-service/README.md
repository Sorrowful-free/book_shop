# catalog-service

Book catalog: metadata, stock and **temporary reservations** — all in
PostgreSQL `catalog_db` (single source of truth). NestJS gRPC microservice
on `:50052`, contract `bookshop.catalog.v1` (`packages/contracts/proto/catalog.proto`).
Spec: `docs/specs/02-catalog-service.md`.

## Responsibilities

- CRUD + offset listing + search (case-insensitive substring on
  `book_name`/`author`, exact `genre`) for the storefront.
- Soft delete (`deleted_at`): deleted books stay readable
  (`is_deleted=true`, `available=0`) but cannot be reserved;
  `RestoreBook` (ADMIN) brings them back.
- Reservations in Postgres (`reservations` + `reservation_items`):
  `ReserveStock` — atomic all-or-nothing with row locking and TTL
  (`RESERVATION_TTL_SEC`); `CommitStock` — idempotent stock decrement;
  `ReleaseStock` — cancellation. `available = stock − live reservations`,
  expired reservations ignored lazily + marked `EXPIRED` by a sweeper
  (`RESERVATION_SWEEP_INTERVAL_SEC`).
- `book.created|updated|deleted` events via transactional outbox
  (`OutboxRelay` from `@book-shop/common`, lazy Kafka producer — the
  service boots with a dead broker).
- Request shape (required non-empty fields, `1 ≤ limit ≤ 100`,
  `offset ≥ 0`, `amount ≥ 1`) is validated at the gRPC boundary by
  class-validator DTOs (`src/dto.ts`) — violations → `INVALID_ARGUMENT`
  before domain logic runs. DB-column guards (`price ≤ 99 999 999.99`,
  int32 stock / aggregated reservation amount) stay in `CatalogService`.

## Auth

Every RPC verifies the JWT in `authorization` metadata itself
(`JwtVerifier` + `RedisTokenDenylist` from `@book-shop/common`):
reads are public; Create/Update need EMPLOYER|ADMIN; Delete/Restore need
ADMIN; Reserve/Commit/Release need any valid JWT.

## Env

See `.env.example`: `GRPC_PORT`, `DATABASE_URL`, `KAFKA_BROKERS`,
`JWT_PUBLIC_KEY` (or `JWT_PUBLIC_KEY_FILE` — the file wins when set),
`REDIS_URL`, `RESERVATION_TTL_SEC`, `RESERVATION_SWEEP_INTERVAL_SEC`.

## Commands

```bash
bun --filter @book-shop/catalog-service db:generate  # prisma generate
bun --filter @book-shop/catalog-service db:migrate   # prisma migrate dev
bun --filter @book-shop/catalog-service db:deploy    # prisma migrate deploy
bun --filter @book-shop/catalog-service db:seed      # demo books
bun --filter @book-shop/catalog-service start        # gRPC server
bun test apps/catalog-service                        # unit + e2e
```
