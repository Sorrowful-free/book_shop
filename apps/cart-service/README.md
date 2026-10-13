# cart-service

Temporary shopping carts — NestJS gRPC on `:50053`. Spec:
[`docs/specs/03-cart-service.md`](../../docs/specs/03-cart-service.md).

- **Guest carts** — addressed by a service-issued uuid `cart_id` (`CreateCart`,
  kept client-side in a cookie); no auth required.
- **User carts** — addressed by `sub` of a verified JWT from `authorization`
  gRPC metadata (EdDSA `JwtVerifier` + `RedisTokenDenylist` from
  `@book-shop/common`); a missing/invalid/revoked token → `UNAUTHENTICATED`.
- **Storage** — Redis only: `cart:user:{user_id}` / `cart:guest:{cart_id}`
  JSON documents with a **sliding TTL** (`CART_TTL_SEC`) renewed on every
  successful cart-touching RPC.
- **Kafka** — consumes `order.order.events` (`order.order.created`,
  group `cart-service`) → decrements only the purchased positions
  (`goods[]`) in the user's cart; deduplicated by `orderId` — a
  redelivery is a no-op (at-least-once safe). No producers.
- **Boundary validation** — request DTOs (`class-validator` +
  `ValidationPipe` on the gRPC controller) check the static shape before
  the domain service: `cart_id`/`guest_cart_id` uuid format (a present
  `cart_id: ""` is `INVALID_ARGUMENT`, not user-cart mode), non-empty
  `book_id`, `amount` int (`AddItem ≥ 1`, `UpdateItem ≥ 0`). Accumulated
  `amount` is capped at int32 max (`addItem`, `mergeCart` →
  `INVALID_ARGUMENT`, no mutation).

## Run

```bash
cp .env.example .env   # set JWT_PUBLIC_KEY (same Ed25519 key as auth-service)
bun run infra:up       # redis + kafka (repo root)
bun run start          # gRPC :50053 + Kafka consumer (hybrid app)
```

## Test

```bash
bun test src                     # unit (in-memory repository)
bun test test/cart.e2e.spec.ts   # e2e — needs real redis :6379 + kafka :29092
```

Env vars: `GRPC_PORT`, `REDIS_URL`, `CART_TTL_SEC`, `KAFKA_BROKERS`,
`JWT_PUBLIC_KEY` (or `JWT_PUBLIC_KEY_FILE` — the file wins when set) —
see [`.env.example`](./.env.example).
