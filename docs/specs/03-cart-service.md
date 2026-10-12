# 03. cart-service

> Статус: draft
> Proto: `packages/contracts/proto/cart.proto`
> Порт: `:50053` | Хранилище: Redis

## 1. Ответственность и границы

Временные корзины покупок: пользовательские (по `sub` верифицированного JWT
из metadata `authorization`) и гостевые (по выданному сервисом `cart_id`).
Хранение, изменение позиций, merge гостевой корзины в пользовательскую при
логине, очистка по событию `order.order.created`.

Делает: корзины с TTL в Redis.
НЕ делает: цены/наличие (catalog), заказы (order). JWT верифицирует сам
(`JwtVerifier` из `@book-shop/common`).

## 2. gRPC-контракт

Package `bookshop.cart.v1`, файл `packages/contracts/proto/cart.proto`:

| RPC         | Request                          | Response                 | Ошибки                         |
| ----------- | -------------------------------- | ------------------------ | ------------------------------ |
| CreateCart  | —                                | cart_id                  | —                              |
| GetCart     | cart_id?                         | Cart                     | UNAUTHENTICATED (user-корзина без JWT), INVALID_ARGUMENT |
| AddItem     | cart_id?, book_id, amount        | Cart                     | UNAUTHENTICATED, INVALID_ARGUMENT |
| UpdateItem  | cart_id?, book_id, amount        | Cart                     | UNAUTHENTICATED, INVALID_ARGUMENT, NOT_FOUND |
| RemoveItem  | cart_id?, book_id                | Cart                     | UNAUTHENTICATED, INVALID_ARGUMENT |
| ClearCart   | cart_id?                         | Empty                    | UNAUTHENTICATED, INVALID_ARGUMENT |
| MergeCart   | guest_cart_id                    | Cart                     | INVALID_ARGUMENT, UNAUTHENTICATED (нет валидного JWT) |

`Cart`: `{ items: [{ book_id, amount }], expires_at }` — сырые id книг,
без обогащения (обогащение — зона gateway/BFF).

**Идентификация owner'а:**
- `cart_id` присутствует в запросе → гостевая корзина (uuid, выдаётся
  `CreateCart`, хранится в cookie).
- `cart_id` отсутствует → пользовательская корзина: требуется валидный JWT,
  user_id из `sub`. Нет/невалидный JWT → UNAUTHENTICATED.
- `INVALID_ARGUMENT` — только за malformed `cart_id`/невалидные поля.
- Исключение: `MergeCart.guest_cart_id` — это поле merge-источника, оно НЕ
  включает guest-режим запроса; целевая корзина всегда пользовательская по JWT.
- Sliding TTL продлевается только при успешном обращении (ошибка → без продления).

**Семантика:**
- `AddItem` — суммирует amount при повторном добавлении книги.
- `UpdateItem` — задаёт абсолютный amount; amount=0 равносильно RemoveItem;
  отсутствующая позиция → NOT_FOUND.
- `MergeCart` — позиции гостевой корзины суммируются в пользовательскую,
  гостевая удаляется; несуществующий guest_cart_id → успех без изменений
  (no-op). Вызывается gateway после login/register.
- `ClearCart` — идемпотентен.
- `Cart.expires_at` — для отсутствующей/пустой корзины не возвращается
  (поле пустое).
- **Скользящий TTL**: любой успешный RPC, трогающий корзину (включая GetCart),
  продлевает TTL на `CART_TTL_SEC`.

## 3. Модель данных и хранилище

Redis only:

```
cart:user:{user_id}    → JSON { items: [{book_id, amount}] }   (TTL)
cart:guest:{cart_id}   → JSON { items: [{book_id, amount}] }   (TTL)
```

TTL обновляется через `EXPIRE` на каждом обращении. Пустая/отсутствующая
корзина читается как пустой Cart (это не ошибка).

Доступ к Redis — через repository-интерфейс (моки в unit-тестах).

## 4. События Kafka

| Направление | Топик                  | eventType              | Действие                        |
| ----------- | ---------------------- | ---------------------- | ------------------------------- |
| consume     | `order.order.events`   | `order.order.created`  | ClearCart по `payload.userId`   |

Consumer group `cart-service`. Продюсеров нет. Ошибка consume → retry
кафкой; очистка корзины best-effort (худший случай — корзина доживёт до TTL).

## 5. Зависимости

Исходящих gRPC-зависимостей нет (обогащение позиций — ответственность
api-gateway). Инфра: Redis, Kafka (только consume).

Входящие: api-gateway (все RPC), order-service (GetCart при checkout),
Kafka consumer (`order.order.created` → ClearCart).

## 6. Аутентификация и авторизация

Сервис верифицирует JWT из metadata `authorization` (EdDSA public key,
`JwtVerifier` из `@book-shop/common`).

- Операции над пользовательской корзиной (без `cart_id` в запросе) — валидный
  JWT обязателен; user_id берётся из `sub` токена, не из metadata-полей.
- Гостевые операции по `cart_id` — JWT не нужен; корзина защищена
  неугадываемым uuid.
- `MergeCart` — валидный JWT обязателен (сливает guest → user).
- Kafka-consumer (`order.created` → ClearCart) внутренний, токена нет — ок.

## 7. Env-переменные

| Переменная      | Назначение              | Пример                  |
| --------------- | ----------------------- | ----------------------- |
| `GRPC_PORT`     | порт gRPC-сервера       | `50053`                 |
| `REDIS_URL`     | подключение к Redis     | `redis://localhost:6379`|
| `CART_TTL_SEC`  | TTL корзины (sliding)   | `604800` (7 дней)       |
| `KAFKA_BROKERS` | brokers через запятую   | `localhost:29092`       |
| `JWT_PUBLIC_KEY`| PEM публичного ключа, base64 | `<base64>`         |

## 8. Модель ошибок

- операция над пользовательской корзиной без валидного JWT (нет cart_id):
  UNAUTHENTICATED
- malformed cart_id / amount ≤ 0 при AddItem / < 0 при UpdateItem: INVALID_ARGUMENT
- UpdateItem/RemoveItem по отсутствующей позиции: NOT_FOUND
- MergeCart без валидного JWT: UNAUTHENTICATED

## 9. Acceptance criteria

- CreateCart → uuid cart_id; GetCart по нему → пустая корзина
- AddItem: новая книга → позиция; повтор → amount суммируется
- UpdateItem: меняет amount; 0 → позиция удалена; несуществующая → NOT_FOUND
- RemoveItem удаляет позицию; ClearCart очищает/идемпотентен
- Пользовательская корзина по JWT `sub` изолирована от гостевой
- MergeCart: гостевые позиции переносятся в пользовательскую с суммированием,
  гостевая удаляется
- Sliding TTL: после операции expires_at обновлён; без обращений корзина
  протухает по TTL
- Событие `order.order.created` с userId → пользовательская корзина очищена
- Токены/данные пользователя в ключах не дублируются — только user_id в key

## 10. Test plan

- Unit (`bun test`, `*.spec.ts`, Redis за repository-интерфейсом, мокается):
  суммирование AddItem, UpdateItem=0 → remove, merge-суммирование,
  выбор owner (cart_id vs metadata), вызов EXPIRE на каждой операции,
  маппинг ошибок → gRPC codes
- e2e (`test/cart.e2e.spec.ts`, реальные redis+kafka):
  guest lifecycle create→add→update→remove→clear; пользовательская корзина
  по metadata; merge при логине; TTL-истечение (`CART_TTL_SEC=1` + ожидание);
  продление TTL при обращении; публикация `order.order.created` тестовым
  producer'ом → корзина очищена

## 11. NFR

- Runtime portability: Node.js LTS + Bun, без `Bun.*`/`bun:*` (AGENTS.md)
- Корзина атомарно мутируется под одним ключом; конкурентные записи — last-write-wins (допустимо для учебного проекта)
- `CART_TTL_SEC` дефолт 7 дней; гостевые и пользовательские TTL одинаковы
- gRPC deadline: 5s со стороны клиента
