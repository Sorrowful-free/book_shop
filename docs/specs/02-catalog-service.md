# 02. catalog-service

> Статус: draft
> Proto: `packages/contracts/proto/catalog.proto`
> Порт: `:50052` | Хранилище: PostgreSQL `catalog_db` (user `catalog_user`)

## 1. Ответственность и границы

Каталог книг: владеет метаданными книг, остатками (stock) и **временными
резервами** на них — всё в одной PostgreSQL-базе (единый источник правды).
CRUD + поиск для витрины, резервирование/фиксация/возврат остатков для
checkout-оркестрации order-service.

Делает: хранение книг, поиск/листинг/выборки по id, резервы с TTL,
атомарное списание stock при фиксации, публикация `book.*` событий через outbox.
НЕ делает: корзину, заказы, платежи.

## 2. gRPC-контракт

Package `bookshop.catalog.v1`, файл `packages/contracts/proto/catalog.proto`:

| RPC              | Request                              | Response                    | Ошибки                                   |
| ---------------- | ------------------------------------ | --------------------------- | ---------------------------------------- |
| ListBooks        | offset, limit                        | books[], total              | INVALID_ARGUMENT                         |
| SearchBooks      | query?, genre?, offset, limit        | books[], total              | INVALID_ARGUMENT                         |
| GetBook          | book_id                              | Book                        | NOT_FOUND                                |
| GetBooksByIds    | book_ids[]                           | books[]                     | NOT_FOUND (если хоть один не найден)     |
| CreateBook       | поля книги                           | Book                        | UNAUTHENTICATED, PERMISSION_DENIED, INVALID_ARGUMENT, ALREADY_EXISTS (isbn) |
| UpdateBook       | book_id + опциональные поля          | Book                        | UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT |
| DeleteBook       | book_id                              | Empty                       | UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND |
| RestoreBook      | book_id                              | Book                        | UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND, FAILED_PRECONDITION (не удалена) |
| ReserveStock     | items[] {book_id, amount}            | reservation_id, expires_at  | UNAUTHENTICATED, NOT_FOUND, FAILED_PRECONDITION (недоступно), INVALID_ARGUMENT |
| CommitStock      | reservation_id                       | Empty                       | UNAUTHENTICATED, NOT_FOUND (резерв истёк/не найден) |
| ReleaseStock     | reservation_id                       | Empty                       | UNAUTHENTICATED, NOT_FOUND               |

`Book`: book_id, book_name, author, isbn, description, genre, year, cover_url,
price (double), stock, available, is_deleted, created_at, updated_at.
`stock` — сырой остаток; `available` = `stock − активные резервы` (для
deleted-книги `available=0`) — gateway использует `available` для витрины.

- `ListBooks`/`SearchBooks`: offset-пагинация, limit ≤ 100. SearchBooks —
  `query` как substring-match по book_name/author (case-insensitive),
  `genre` — точный фильтр; оба опциональны. Удалённые книги присутствуют в
  выдаче с `is_deleted=true` (остаются на витрине).
- `ReserveStock` — все позиции атомарно в одной транзакции: для каждой книги
  `stock − активные_резервы >= amount` и `is_deleted=false`, иначе
  FAILED_PRECONDITION (в details — список недоступных book_id). Резерв —
  запись в `reservations` с `expires_at` (TTL `RESERVATION_TTL_SEC`,
  дефолт 900s); по истечении резерв не учитывается и чистится.
- `CommitStock` — фиксация резерва при успешном checkout: атомарно уменьшает
  stock и помечает резерв COMMITTED. **Идемпотентен**: резерв уже COMMITTED →
  успех без повторного списания (защита от ретрая order'а). Истёкший →
  NOT_FOUND; RELEASED/несуществующий → NOT_FOUND.
- `ReleaseStock` — отмена резерва → status RELEASED (компенсация при отказе
  checkout). Истёкший/несуществующий → NOT_FOUND.
- `DeleteBook` — **soft delete**: ставит `deleted_at`; книга видна в каталоге,
  но недоступна для резервирования. `RestoreBook` снимает флаг.

## 3. Модель данных и хранилище

PostgreSQL `catalog_db`, Prisma:

```prisma
model Book {
  id          String    @id @default(uuid())
  bookName    String    @map("book_name")
  author      String
  isbn        String?   @unique
  description String?
  genre       String?
  year        Int?
  coverUrl    String?   @map("cover_url")
  price       Decimal   @db.Decimal(10, 2)
  stock       Int       @default(0)
  deletedAt   DateTime? @map("deleted_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  reservations Reservation[]
  @@map("books")
}
enum ReservationStatus { ACTIVE COMMITTED RELEASED EXPIRED }
model Reservation {
  id        String            @id @default(uuid())
  status    ReservationStatus @default(ACTIVE)
  expiresAt DateTime          @map("expires_at")
  items     ReservationItem[]
  createdAt DateTime          @default(now()) @map("created_at")
  @@map("reservations")
}
model ReservationItem {
  id            String      @id @default(uuid())
  reservationId String      @map("reservation_id")
  reservation   Reservation @relation(fields: [reservationId], references: [id])
  bookId        String      @map("book_id")
  book          Book        @relation(fields: [bookId], references: [id])
  amount        Int
  @@map("reservation_items")
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

Индексы: `book_name`, `genre`; `reservation_items.book_id`,
`reservations(status, expires_at)`.
Seed: 5–10 демо-книг с разными жанрами и stock > 0.

Доступность книги = `stock − Σ amount активных (ACTIVE, непросроченных)
резервов`. Reserve/Commit/Release — транзакции с блокировкой строк книги
(`SELECT … FOR UPDATE` или `UPDATE … WHERE stock >= amount`). Протухшие
ACTIVE-резервы лениво игнорируются по `expires_at`; периодический sweeper
помечает их EXPIRED/чистит (интервал env-настраиваемый).

Доступ к БД — через repository-интерфейсы (моки в unit-тестах).

## 4. События Kafka

| Направление | Топик                  | eventType                | Payload                              |
| ----------- | ---------------------- | ------------------------ | ------------------------------------ |
| produce     | `catalog.book.events`  | `catalog.book.created`   | `{ bookId, bookName, author, price }`|
| produce     | `catalog.book.events`  | `catalog.book.updated`   | `{ bookId, bookName, author, price }`|
| produce     | `catalog.book.events`  | `catalog.book.deleted`   | `{ bookId }`                         |

**Transactional outbox**: мутация книги + запись в `outbox` — одна транзакция;
`OutboxRelay` (`@book-shop/common`) публикует в Kafka at-least-once.
Недоступный брокер мутацию не ломает. Reserve/Commit/Release и RestoreBook
событий не публикуют.

## 5. Зависимости

Исходящих gRPC-зависимостей нет. Инфра: PostgreSQL, Kafka, Redis (denylist
для JwtVerifier — только чтение `auth:revoked:*`).
Входящие потребители: order-service (`GetBooksByIds`, `ReserveStock`,
`CommitStock`, `ReleaseStock` — с пробросом `authorization`), api-gateway.

## 6. Аутентификация и авторизация

Сервис верифицирует JWT из metadata `authorization` (EdDSA public key,
`JwtVerifier` из `@book-shop/common`).

- Read-RPC (List/Search/Get/GetBooksByIds) — публичные, токен не требуется.
- Write-RPC: Create/Update — валидный JWT + роль EMPLOYER или ADMIN;
  Delete/Restore — только ADMIN (деструктивные операции строже, консистентно
  с gateway-матрицей); иначе UNAUTHENTICATED/PERMISSION_DENIED.
- Reserve/Commit/Release — валидный JWT (любая роль): order-service
  проксирует токен пользователя.

## 7. Env-переменные

| Переменная            | Назначение                    | Пример                                                  |
| --------------------- | ----------------------------- | ------------------------------------------------------- |
| `GRPC_PORT`           | порт gRPC-сервера             | `50052`                                                 |
| `DATABASE_URL`        | строка подключения Prisma     | `postgresql://catalog_user:catalog_pass@localhost:5432/catalog_db` |
| `KAFKA_BROKERS`       | brokers через запятую         | `localhost:29092`                                       |
| `JWT_PUBLIC_KEY`      | PEM публичного ключа, base64  | `<base64>`                                              |
| `REDIS_URL`           | Redis (denylist, только чтение) | `redis://localhost:6379`                              |
| `RESERVATION_TTL_SEC` | TTL резерва                   | `900`                                                   |
| `RESERVATION_SWEEP_INTERVAL_SEC` | интервал sweeper'а просроченных резервов | `60`                       |

## 8. Модель ошибок

- validation: INVALID_ARGUMENT (price ≥ 0, stock ≥ 0, year в разумных рамках,
  limit 1–100)
- дубликат isbn: ALREADY_EXISTS
- книга/резерв не найдены: NOT_FOUND
- книга удалена или stock не хватает при ReserveStock: FAILED_PRECONDITION
- RestoreBook по неудалённой книге: FAILED_PRECONDITION
- нет/невалидный JWT там, где требуется: UNAUTHENTICATED
- роль ниже EMPLOYER на Create/Update, ниже ADMIN на Delete/Restore:
  PERMISSION_DENIED

## 9. Acceptance criteria

- CRUD: CreateBook → в БД + outbox-запись → `book.created` доставлен;
  UpdateBook меняет поля + `book.updated`; события доезжают и при временном
  недоступном Kafka (outbox-retry)
- DeleteBook — soft: `is_deleted=true`, книга видна в List/Search/GetBook,
  но ReserveStock её отклоняет; `book.deleted` опубликовано
- RestoreBook снимает флаг; по неудалённой → FAILED_PRECONDITION
- CreateBook с занятым isbn → ALREADY_EXISTS; без isbn → создаётся
- CreateBook без JWT → UNAUTHENTICATED; с ролью CUSTOMER → PERMISSION_DENIED
- DeleteBook/RestoreBook с ролью EMPLOYER → PERMISSION_DENIED (только ADMIN)
- ListBooks: пагинация работает, total возвращается, limit > 100 → INVALID_ARGUMENT
- SearchBooks: query ищет по name+author без учёта регистра; genre фильтрует точно
- GetBooksByIds: все найдены → books[]; хоть один нет → NOT_FOUND на весь запрос
- ReserveStock: доступно (stock − активные резервы ≥ amount) → reservation_id +
  expires_at; нехватка хоть в одной позиции → FAILED_PRECONDITION,
  резервы не создаются; deleted-книга → FAILED_PRECONDITION
- Истёкший TTL резерва освобождает доступность (без ручного Release)
- CommitStock: валидный резерв → stock уменьшен, резерв COMMITTED; повторный
  CommitStock на COMMITTED → успех без повторного списания (идемпотентен);
  истёкший → NOT_FOUND
- ReleaseStock: резерв → RELEASED, доступность возвращена; несуществующий → NOT_FOUND

## 10. Test plan

Изоляция: repository-интерфейсы мокаются в unit; e2e — уникальные
isbn на тест, очистка не нужна.

- Unit: валидация полей/пагинации; маппинг ошибок → gRPC codes; расчёт
  доступности (stock − активные резервы); логика Reserve/Commit/Release;
  построение search-условий; JWT-гард (нет токена/невалидный/роль);
  outbox-запись в той же транзакции
- e2e (`test/catalog.e2e.spec.ts`, реальные postgres+kafka):
  CRUD + фактическая публикация `book.*` через outbox-relay (consumer);
  List/Search по сиднутым книгам; soft delete виден но не резервируется;
  Reserve→Commit (stock уменьшился) и Reserve→Release; TTL-истечение резерва
  (`RESERVATION_TTL_SEC=1` + ожидание → доступность вернулась);
  JWT: write-RPC с тестовым токеном CUSTOMER → PERMISSION_DENIED, ADMIN → ok;
  outbox при недоступном брокере → доставка после восстановления

## 11. NFR

- Runtime portability: Node.js LTS + Bun, без `Bun.*`/`bun:*` (правило AGENTS.md)
- Резервы временны по определению — TTL обязателен, «вечного» резерва нет;
  просроченные чистятся sweeper'ом
- CommitStock по истёкшему резерву → NOT_FOUND (order отменяет заказ);
  по COMMITTED-резерву → идемпотентный успех (ретрай order'а безопасен)
- Outbox: at-least-once; консьюмеры обязаны быть идемпотентны
- price хранится Decimal(10,2), в proto — double
- gRPC deadline: 5s со стороны клиента
