# order-service

Orders: checkout saga over cart+catalog, order history with item snapshots,
payment emulation, cancellation — all in PostgreSQL `order_db` (single
source of truth). NestJS gRPC microservice on `:50054`, contract
`bookshop.order.v1` (`packages/contracts/proto/order.proto`).
Spec: `docs/specs/04-order-service.md` + `docs/specs/fixes/order-service.md`
(F-O1..F-O5).

## Responsibilities

- `Checkout` saga: `cart.GetCart` → `catalog.GetBooksByIds` snapshot →
  `catalog.ReserveStock` → persist PENDING + `order.order.created` outbox
  row in ONE transaction (transactional outbox; `OutboxRelay` from
  `@book-shop/common` publishes to `order.order.events` — a dead broker
  does not break checkout). Every dependency call forwards the caller's
  `authorization` metadata verbatim with a 5s deadline.
- Idempotent checkout: unique `(user_id, idempotency_key)` — a repeated key
  returns the existing order without a new saga; a lost insert race
  releases the orphan reservation and returns the winner.
- `PayOrder` (emulation): PENDING → `catalog.CommitStock` → PAID +
  `order.paid`. Idempotent on PAID (F-O3); an expired reservation
  (`NOT_FOUND`) or uncommittable stock (`FAILED_PRECONDITION`, F-O1) cancels
  the order + `order.cancelled` and answers FAILED_PRECONDITION.
- `CancelOrder`: PENDING → `catalog.ReleaseStock` → CANCELLED +
  `order.cancelled`. A COMMITTED reservation (details
  `reservationStatus: "COMMITTED"`, catalog F-C4) self-heals the order to
  PAID + `order.paid` (F-O2); RELEASED/expired still yield CANCELLED.
- `GetOrder`/`ListMyOrders`: own orders only (ADMIN/EMPLOYER may read any);
  `created_at DESC, id DESC` listing, `book_id ASC` items (F-O5).
- Dependency errors pass through with code/message/details intact — only
  transport failures (connection refused, deadline) map to UNAVAILABLE
  (F-O4). Structured details ride in `error-details` trailing metadata —
  the wire channel grpc-js actually forwards.

## Auth

Every RPC verifies the JWT in `authorization` metadata itself
(`JwtVerifier` + `RedisTokenDenylist` from `@book-shop/common` — Redis is
read-only here). Ownership: `sub == user_id` or role ADMIN/EMPLOYER for
Get/Pay/Cancel; Checkout/ListMyOrders run under the caller's `sub`.

## Env

See `.env.example`: `GRPC_PORT`, `DATABASE_URL`, `KAFKA_BROKERS`,
`JWT_PUBLIC_KEY` (or `JWT_PUBLIC_KEY_FILE` — the file wins when set),
`REDIS_URL`, `CART_GRPC_ADDR`, `CATALOG_GRPC_ADDR`.

## Commands

```bash
bun --filter @book-shop/order-service db:generate  # prisma generate
bun --filter @book-shop/order-service db:migrate   # prisma migrate dev
bun --filter @book-shop/order-service db:deploy    # prisma migrate deploy
bun --filter @book-shop/order-service start        # gRPC server
bun test apps/order-service                        # unit + e2e
```
