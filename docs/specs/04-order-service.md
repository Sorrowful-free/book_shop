# 04. order-service

> Статус: approved
> Proto: `packages/contracts/proto/order.proto`
> Порт: `:50054` | Хранилище: PostgreSQL `order_db` (user `order_user`)

## 1. Ответственность и границы

Заказы: оркестрация checkout (saga), хранение истории заказов со снапшотом
позиций, эмуляция оплаты, отмена.

Делает: checkout из корзины (cart.GetCart → catalog.ReserveStock → persist →
outbox event), жизненный цикл PENDING → PAID/CANCELLED, CommitStock при оплате,
ReleaseStock при отмене, idempotency при повторных checkout.
НЕ делает: каталог, корзину, платежи настоящие (эмуляция).

## 2. gRPC-контракт

Package `bookshop.order.v1`, файл `packages/contracts/proto/order.proto`:

| RPC          | Request              | Response          | Ошибки                                                    |
| ------------ | -------------------- | ----------------- | --------------------------------------------------------- |
| Checkout     | idempotency_key      | Order             | UNAUTHENTICATED, FAILED_PRECONDITION (пустая корзина), NOT_FOUND, UNAVAILABLE (deps) |
| GetOrder     | order_id             | Order             | UNAUTHENTICATED, NOT_FOUND, PERMISSION_DENIED             |
| ListMyOrders | offset, limit        | orders[], total   | UNAUTHENTICATED, INVALID_ARGUMENT (limit вне 1–100)       |
| PayOrder     | order_id             | Order             | UNAUTHENTICATED, NOT_FOUND, PERMISSION_DENIED, FAILED_PRECONDITION (не PENDING / резерв истёк) |
| CancelOrder  | order_id             | Order             | UNAUTHENTICATED, NOT_FOUND, PERMISSION_DENIED, FAILED_PRECONDITION (PAID/CANCELLED) |

`Order`: order_id, user_id, items[] {book_id, book_name, author, price, amount}
(снапшот на момент покупки), total_price, status (PENDING/PAID/CANCELLED),
created_at, paid_at?, cancelled_at?.

**Checkout-сага** (все вызовы проксируют `authorization` пользователя):
1. `cart.GetCart` → пустая → FAILED_PRECONDITION
2. `catalog.GetBooksByIds` → снапшот name/author/price; промах по книге → NOT_FOUND
3. `catalog.ReserveStock(items)` → reservation_id
4. persist Order (PENDING, reservation_id, idempotency_key) в Postgres
   + outbox-запись `order.created` — одна транзакция
5. (async) cart-service чистит корзину по событию `order.order.created`

**Идемпотентность Checkout**: `idempotency_key` обязателен (uuid; producer —
gateway: принимает `Idempotency-Key` заголовок или генерит uuid).
Уникальный индекс по (user_id, idempotency_key). Повторный запрос с тем же
ключом → возвращается существующий заказ без новой саги. Гонка двух
параллельных checkout с одним ключом: проигравший падает на unique violation
→ читает и возвращает уже созданный заказ (не ошибку).

**Компенсация при сбоях**: падение на шагах 2–3 → безопасно (резерва нет или
Release); падение persist → ReleaseStock. Недоступный cart/catalog →
UNAVAILABLE с компенсацией уже сделанных шагов.

**PayOrder** (эмуляция оплаты, всегда «успешна»): PENDING →
`catalog.CommitStock(reservation_id)` → status PAID + outbox `order.paid`.
CommitStock идемпотентен в catalog: ретрай PayOrder после сбоя persist
(резерв уже COMMITTED) → успех без повторного списания, заказ → PAID.
Резерв истёк (catalog NOT_FOUND по ACTIVE/EXPIRED) → order → CANCELLED +
outbox `order.cancelled`, caller получает FAILED_PRECONDITION.

**CancelOrder**: PENDING → `catalog.ReleaseStock(reservation_id)` → CANCELLED +
outbox `order.cancelled`. ReleaseStock → NOT_FOUND (резерв истёк) или
FAILED_PRECONDITION (уже COMMITTED/RELEASED) — считается успешной
компенсацией, заказ всё равно → CANCELLED. Краевой случай crash-gap:
заказ PENDING с COMMITTED-резервом (persist упал после commit) — отменяется,
но stock не восстанавливается (документированный компромисс учебной саги).
PAID/CANCELLED → FAILED_PRECONDITION.

## 3. Модель данных и хранилище

PostgreSQL `order_db`, Prisma:

```prisma
model Order {
  id             String      @id @default(uuid())
  userId         String      @map("user_id")
  status         OrderStatus @default(PENDING)
  totalPrice     Decimal     @map("total_price") @db.Decimal(10, 2)
  reservationId  String?     @map("reservation_id")
  idempotencyKey String      @map("idempotency_key")
  items          OrderItem[]
  createdAt      DateTime    @default(now()) @map("created_at")
  paidAt         DateTime?   @map("paid_at")
  cancelledAt    DateTime?   @map("cancelled_at")
  @@unique([userId, idempotencyKey])
  @@map("orders")
}
enum OrderStatus { PENDING PAID CANCELLED }
model OrderItem {
  id       String  @id @default(uuid())
  orderId  String  @map("order_id")
  order    Order   @relation(fields: [orderId], references: [id])
  bookId   String  @map("book_id")
  bookName String  @map("book_name")
  author   String
  price    Decimal @db.Decimal(10, 2)
  amount   Int
  @@map("order_items")
}
model Outbox {
  id          String    @id @default(uuid())
  eventType   String    @map("event_type")
  payload     Json
  publishedAt DateTime? @map("published_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  @@map("outbox")
}
```

Доступ к БД — repository-интерфейс; gRPC-клиенты cart/catalog — за
client-интерфейсами (всё мокается в unit).

## 4. События Kafka

| Направление | Топик                 | eventType               | Payload                                    |
| ----------- | --------------------- | ----------------------- | ------------------------------------------ |
| produce     | `order.order.events`  | `order.order.created`   | `{ orderId, userId, goods[], totalPrice }` |
| produce     | `order.order.events`  | `order.order.paid`      | `{ orderId, userId, totalPrice }`              |
| produce     | `order.order.events`  | `order.order.cancelled` | `{ orderId, userId }`                      |

**Transactional outbox** (at-least-once, `OutboxRelay` из `@book-shop/common`):
событие пишется в той же транзакции, что и изменение заказа; недоступный брокер
не ломает операции. Consumer'ов нет.

## 5. Зависимости

Исходящие gRPC: `cart-service` (GetCart), `catalog-service` (GetBooksByIds,
ReserveStock, CommitStock, ReleaseStock) — оба вызова пробрасывают
`authorization`-metadata пользователя (catalog требует JWT на
Reserve/Commit/Release, cart — на пользовательской корзине).
Инфра: PostgreSQL, Kafka, Redis (denylist для JwtVerifier — только чтение).

Входящие: api-gateway (все RPC).

## 6. Аутентификация и авторизация

Сервис верифицирует JWT из metadata `authorization` (EdDSA public key,
`JwtVerifier` из `@book-shop/common`) — требуется на **всех** RPC.

Ownership: GetOrder/PayOrder/CancelOrder — владелец заказа (`sub == user_id`)
или роль ADMIN/EMPLOYER, иначе PERMISSION_DENIED.
Checkout/ListMyOrders — работают по `sub` из токена.

## 7. Env-переменные

| Переменная          | Назначение                 | Пример                                                 |
| ------------------- | -------------------------- | ------------------------------------------------------ |
| `GRPC_PORT`         | порт gRPC-сервера          | `50054`                                                |
| `DATABASE_URL`      | строка подключения Prisma  | `postgresql://order_user:order_pass@localhost:5432/order_db` |
| `KAFKA_BROKERS`     | brokers через запятую      | `localhost:29092`                                      |
| `JWT_PUBLIC_KEY`    | PEM публичного ключа, base64 | `<base64>`                                           |
| `REDIS_URL`         | Redis (denylist, только чтение) | `redis://localhost:6379`                         |
| `CART_GRPC_ADDR`    | адрес cart-service         | `localhost:50053`                                      |
| `CATALOG_GRPC_ADDR` | адрес catalog-service      | `localhost:50052`                                      |

## 8. Модель ошибок

- нет/невалидный JWT: UNAUTHENTICATED
- чужой заказ без ADMIN/EMPLOYER: PERMISSION_DENIED
- пустая корзина / заказ не PENDING / резерв истёк: FAILED_PRECONDITION
- заказ/книга не найдены: NOT_FOUND
- недоступный cart/catalog: UNAVAILABLE (с компенсацией)
- validation: INVALID_ARGUMENT

## 9. Acceptance criteria

- Checkout по корзине с позициями → Order PENDING: позиции со снапшотом
  name/author/price, total = Σ price*amount, outbox `order.created` → событие
  доставлено, резерв создан в catalog
- Повторный Checkout с тем же idempotency_key → тот же заказ, без новых
  вызовов cart/catalog
- Checkout по пустой корзине → FAILED_PRECONDITION, без резерва и записи
- Checkout при промахе книги в каталоге → NOT_FOUND, резерв не создан
- Checkout при недоступном cart/catalog → UNAVAILABLE + компенсация
- Checkout при недоступном Kafka → успех (событие уйдёт outbox'ом позже)
- PayOrder: PENDING → PAID, CommitStock вызван (stock списан), `order.paid`;
  повторный → FAILED_PRECONDITION
- PayOrder по истёкшему резерву → FAILED_PRECONDITION, заказ → CANCELLED,
  `order.cancelled` опубликован
- CancelOrder: PENDING → CANCELLED + ReleaseStock вызван; PAID → FAILED_PRECONDITION
- GetOrder свой → Order; чужой без ADMIN/EMPLOYER → PERMISSION_DENIED;
  несуществующий → NOT_FOUND; без JWT → UNAUTHENTICATED
- ListMyOrders — только заказы своего user_id, пагинация

## 10. Test plan

- Unit (`bun test`): сага — порядок вызовов cart→catalog→persist→outbox;
  компенсация на каждом шаге; idempotency (повтор по ключу); переходы статусов;
  ownership (свой/чужой/admin/без токена); маппинг ошибок.
  Клиенты (cart/catalog/kafka) и repo — за интерфейсами, мокаются
- e2e (`test/order.e2e.spec.ts`, реальные postgres+kafka; cart/catalog —
  in-process gRPC-стабы по контрактам, принимающие authorization):
  полный checkout→pay→события (consumer проверяет `order.created`/`order.paid`);
  отмена; идемпотентный повтор checkout; «резерв истёк» (стаб → NOT_FOUND);
  outbox при недоступном брокере → доставка после восстановления;
  «catalog down»-стаб → UNAVAILABLE + компенсация
- Сквозной e2e с реальными сервисами — Plan 7

## 11. NFR

- Runtime portability: Node.js LTS + Bun (AGENTS.md)
- PENDING-заказ без оплаты живёт пока резерв не протухнет в catalog
  (`RESERVATION_TTL_SEC`); авто-отмена по таймеру — вне scope этой спеки
- PayOrder — эмуляция, всегда успешен при валидном резерве
- Идемпотентность: ключ хранится, повтор возвращает тот же ресурс
- total_price/price — Decimal(10,2) в БД, double в proto
- gRPC deadline к cart/catalog: 5s; propagation `authorization` обязателен
