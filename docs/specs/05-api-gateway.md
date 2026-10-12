# 05. api-gateway

> Статус: approved
> HTTP :3000 | Хранилище: — | gRPC-клиент ко всем сервисам

## 1. Ответственность и границы

Единственная HTTP-точка входа. Верифицирует JWT публичным ключом (EdDSA),
проксирует запросы сервисам по gRPC, передаёт user-контекст через metadata,
управляет httpOnly-cookie сессией и гостевой корзиной, делает BFF-агрегацию,
экспонирует OpenAPI.

Делает: JWT verify + roles-эндфорсмент, REST→gRPC прокси, cookie-менеджмент,
обогащение корзины данными каталога, маппинг ошибок, swagger.
НЕ делает: бизнес-логику, хранение, выпуск токенов (это auth-service).

## 2. REST API

Global prefix `api/v1` (`app.setGlobalPrefix('api/v1')`). В таблицах указаны
пути контроллеров БЕЗ префикса — фактический URL = `/api/v1<path>` (напр.
`POST /api/v1/auth/register`). Единственное исключение — `GET /api/docs`
(swagger, вне префикса).

### Auth (публичные)

| Method | Route                | gRPC               | Кто             |
| ------ | -------------------- | ------------------ | --------------- |
| POST   | /auth/register       | auth.Register      | public          |
| POST   | /auth/login          | auth.Login         | public          |
| POST   | /auth/refresh        | auth.Refresh       | refresh cookie/body |
| POST   | /auth/logout         | auth.RevokeToken   | refresh cookie/body |
| GET    | /auth/me             | auth.GetUser       | authenticated   |

Login/Register: вызывают gRPC, ставят `access_token`+`refresh_token`
httpOnly-cookies, возвращают токены и в JSON (режим header+body для
API-клиентов). Если у гостя была `cart_id`-cookie → `cart.MergeCart`,
cookie снимается.
Logout: `auth.RevokeToken(refresh_token, access_token?)` — refresh из
cookie/body (сам является credential, access не требуется); текущий access
(cookie/Bearer, если есть) передаётся полем `access_token` → его jti в
denylist даже при просроченном exp. Ошибка RevokeToken (напр. протухший
refresh) не блокирует logout: куки снимаются всегда, ответ 204.
`/auth/me`: `user_id` для `auth.GetUser` берётся из `sub` локально
верифицированного JWT.

### Books (catalog)

| Method | Route                    | gRPC                              | Роли            |
| ------ | ------------------------ | --------------------------------- | --------------- |
| GET    | /books                   | SearchBooks или ListBooks         | public          |
| GET    | /books/:id               | GetBook                           | public          |
| POST   | /books                   | CreateBook                        | Employer, Admin |
| PATCH  | /books/:id               | UpdateBook                        | Employer, Admin |
| DELETE | /books/:id               | DeleteBook                        | Admin           |
| POST   | /books/:id/restore       | RestoreBook                       | Admin           |

GET /books: `offset`, `limit`, опциональные `query`, `genre` — при
query/genre идёт SearchBooks, иначе ListBooks.

### Cart (гость + пользователь)

| Method | Route                        | gRPC            |
| ------ | ---------------------------- | --------------- |
| GET    | /cart                        | cart.GetCart + обогащение catalog.GetBooksByIds |
| POST   | /cart/items                  | AddItem {book_id, amount} |
| PATCH  | /cart/items/:book_id         | UpdateItem {amount} |
| DELETE | /cart/items/:book_id         | RemoveItem |
| DELETE | /cart                        | ClearCart |

Owner-резолюция: гость → `cart_id` cookie передаётся в `cart_id` поля
запросов; авторизованный → JWT в metadata, `cart_id` cookie ИГНОРИРУЕТСЯ
(кроме явного MergeCart после login/register). Если у гостя cookie нет —
gateway вызывает `CreateCart` и ставит `cart_id` httpOnly-cookie.
GET /cart возвращает позиции, обогащённые name/author/price/available
из catalog — BFF-агрегация. Деградация: если `GetBooksByIds` вернул
NOT_FOUND (часть книг удалена/несуществует) — недостающие позиции
возвращаются с `available: false` и без метаданных, весь запрос не падает.

### Orders (только авторизованные)

| Method | Route                     | gRPC           |
| ------ | ------------------------- | -------------- |
| POST   | /orders/checkout          | order.Checkout |
| GET    | /orders                   | ListMyOrders   |
| GET    | /orders/:id               | GetOrder       |
| POST   | /orders/:id/pay           | PayOrder       |
| POST   | /orders/:id/cancel        | CancelOrder    |

Checkout принимает опциональный заголовок `Idempotency-Key` (uuid) —
передаётся в `order.Checkout.idempotency_key`; при отсутствии gateway
генерирует uuid на каждый запрос.

### Docs

`GET /api/docs` — Swagger UI (`@nestjs/swagger`).

## 3. Аутентификация и авторизация на gateway

- JWT EdDSA верифицируется локально (`JwtVerifier` из `@book-shop/common` —
  подпись + Redis-denylist; `JWT_PUBLIC_KEY`, base64 PEM — тот же, что у
  auth-service)
- Источник токена: cookie `access_token` ИЛИ `Authorization: Bearer`
- В gRPC metadata кладётся `authorization` (raw JWT) — сервисы сами
  верифицируют подпись, denylist и достают identity (defense in depth);
  `x-user-*` поля НЕ прокидываются и не доверяются
- Входящий `x-trace-id` (или генерится) прокидывается в metadata — observability
- Roles-гард по матрице §2 — на gateway (первый уровень); сервисы повторно
  проверяют JWT и ownership на своём уровне
- Cookies: `access_token`, `refresh_token`, `cart_id` — httpOnly,
  SameSite=Lax, Path=/, Secure в prod (`COOKIE_SECURE`)

## 4. События Kafka

Нет — gateway не продюсит и не консьюмит события.

## 5. Зависимости

gRPC-клиенты: auth :50051, catalog :50052, cart :50053, order :50054.
Все proto — из `packages/contracts/proto/`. Деградация: UNAVAILABLE от
сервиса → 503.

## 6. Модель ошибок (gRPC → HTTP)

| gRPC                 | HTTP |
| -------------------- | ---- |
| INVALID_ARGUMENT     | 400  |
| UNAUTHENTICATED      | 401  |
| PERMISSION_DENIED    | 403  |
| NOT_FOUND            | 404  |
| ALREADY_EXISTS       | 409  |
| FAILED_PRECONDITION  | 422  |
| UNAVAILABLE          | 503  |
| прочее/нет маппинга  | 500  |

Ответ обёрткивается в единый error-формат `{ statusCode, message, error }`.

## 7. Env-переменные

| Переменная          | Назначение                    | Пример                |
| ------------------- | ----------------------------- | --------------------- |
| `PORT`              | HTTP-порт                     | `3000`                |
| `JWT_PUBLIC_KEY`    | base64 PEM публичного ключа   | `<base64>`            |
| `REDIS_URL`         | Redis (denylist, только чтение) | `redis://localhost:6379` |
| `AUTH_GRPC_ADDR`    | auth-service                  | `localhost:50051`     |
| `CATALOG_GRPC_ADDR` | catalog-service               | `localhost:50052`     |
| `CART_GRPC_ADDR`    | cart-service                  | `localhost:50053`     |
| `ORDER_GRPC_ADDR`   | order-service                 | `localhost:50054`     |
| `COOKIE_SECURE`     | Secure-флаг cookies           | `false` (dev)         |
| `CORS_ORIGIN`       | origin для CORS               | `http://localhost:3001` |

## 8. Acceptance criteria

- register/login → cookies выставлены + токены в JSON; повторный запрос с
  cookie авторизован; Bearer-заголовок тоже работает
- refresh по refresh-cookie → новая пара, куки перезаписаны; протухший/отозванный → 401
- logout → RevokeToken вызван, куки сняты (даже при ошибке revoke, ответ
  204); refresh jti → revoked в БД auth, access jti → Redis-denylist →
  старый access отклоняется верификаторами всех сервисов
- denylist-эффект проверяется с реальным/тестовым Redis или инжектированным
  `TokenDenylist`-стабом
- публичные роуты без токена → 200; защищённые без токена → 401; недостаточная роль → 403
- гость: первая корзинная операция → CreateCart + cookie; далее корзина по
  cart_id; после login — MergeCart вызван, корзина слита
- GET /api/cart → позиции обогащены name/price из catalog
- маппинг ошибок §6 корректен (NOT_FOUND→404 и т.д. — через стабы)
- swagger отдаёт документ на /api/docs
- checkout без авторизации → 401; с авторизацией → проксирован в order

## 9. Test plan

- Unit (`bun test`): JWT verify (валидный/протухший/неверная подпись),
  roles-гард (матрица роутов), cookie-логика (set/clear, Secure/SameSite),
  маппинг gRPC codes → HTTP, обогащение корзины (merge позиций с книгами),
  owner-резолюция (metadata vs cart_id)
- e2e (`test/gateway.e2e.spec.ts`): supertest по HTTP; сервисы — in-process
  gRPC-стабы по контрактам. Сценарии: регистрация с cookie→доступ к /auth/me;
  guest-cart→login→merge; роль-матрица (403/401); маппинг ошибок;
  checkout-проксирование. Сквозной e2e с живыми сервисами — Plan 7.

## 10. NFR

- Runtime portability: Node.js LTS + Bun (AGENTS.md)
- gRPC deadline к сервисам: 5s; на стороне gateway — guard timeout
- Cookies: httpOnly всегда; Secure — через env (prod=true)
- Validation входящих DTO — `class-validator` + global ValidationPipe
