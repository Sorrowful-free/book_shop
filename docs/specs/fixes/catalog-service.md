# Fixes: catalog-service

> Статус: done | Модуль: `apps/catalog-service`

## F-C1. `TRUNCATE` в e2e без CASCADE

### Проблема

`catalog.e2e.spec.ts` делает
`TRUNCATE TABLE "reservation_items", "reservations", "books", "outbox"`.
Работает, пока все таблицы с FK перечислены в одной команде. Но `outbox` не
имеет FK — если у любой новой таблицы появится FK на эти таблицы (или outbox
получит FK), команда упадёт с FK-violation, и ошибка будет неочевидной.

### Ожидаемое поведение

- Очистка в beforeAll использует `TRUNCATE … RESTART IDENTITY CASCADE`.
- Комментарий сохраняет мотивацию (чистый slate между прогонами).

### Acceptance criteria

- e2e-файл стартует на непустой БД без ошибок; smoke: `bun test
  test/catalog.e2e.spec.ts` зелёный дважды подряд.

### Out of scope

- Общий truncate-helper для всех сервисов (auth e2e такой проблемы не имеет —
  его таблицы чистятся иначе; если понадобится — отдельный пункт).

## F-C2. Overflow-гварды на границе БД

### Проблема

Proto-типы шире колонок: `price` — `double`, колонка `Decimal(10,2)` (макс
≈ 99 999 999.99); `stock`/`year`/`amount` — int32 (по проводу не переполнить,
но защита дешёвая); `offset`/`limit` — int32 (уже ограничены 0..100 для
limit; offset без верхней границы, но OFFSET в SQL безопасен). Реальный
вектор: `price: 1e15` проходит `assertPrice` (finite, ≥ 0) → Prisma бросает
ошибку переполнения Decimal → клиент получает `UNKNOWN` вместо
`INVALID_ARGUMENT`. Аналогично — накопленная сумма amount по резервации может
превысить int32/int4 при агрегации дублей bookId.

### Ожидаемое поведение

- `price` ДОЛЖЕН быть ≤ 99 999 999.99 (граница `Decimal(10,2)`) — и в
  `CreateBook`, и в `UpdateBook`; превышение → `INVALID_ARGUMENT`.
- `stock` ДОЛЖЕН быть ≤ 2 147 483 647 (int4); превышение → `INVALID_ARGUMENT`.
- В `ReserveStock` суммарный amount на один `book_id` (с учётом дублей в
  одном запросе) > int32 max → `INVALID_ARGUMENT`, а не переполнение в
  guarded UPDATE.
- Проверки выполняются до обращения к репозиторию.

### Acceptance criteria

- `createBook({price: 1e15})` и `updateBook({price: 1e15})` →
  `INVALID_ARGUMENT` (не UNKNOWN).
- `createBook({stock: 2147483648})` → `INVALID_ARGUMENT`.
- `reserveStock` с двумя позициями одного `book_id`, чья сумма > int32 max →
  `INVALID_ARGUMENT`.
- Unit-тесты на каждую границу; e2e — минимум один (price), остальное unit.

### Out of scope

- Изменение схемы БД (Decimal(10,2) остаётся); int64 поля (total) не трогаем.

## F-C3. Boundary-валидация запросов (class-validator)

### Проблема

Аналогично auth: зависимости установлены, проверки формы
(обязательность/непустота строк, диапазоны offset/limit, amount ≥ 1)
находятся в `CatalogService` вперемешку с доменной логикой.

### Ожидаемое поведение

- DTO + `ValidationPipe` (exceptionFactory → `RpcException` с
  `INVALID_ARGUMENT`) на методах `CatalogController` для RPC, у которых есть
  статические ограничения формы: `ListBooks`, `SearchBooks`, `GetBook`,
  `GetBooksByIds`, `CreateBook`, `UpdateBook`, `DeleteBook`, `RestoreBook`,
  `ReserveStock`, `CommitStock`, `ReleaseStock`.
- Статические ограничения в DTO: обязательные строки непустые,
  `offset ≥ 0`, `1 ≤ limit ≤ 100`, `amount ≥ 1`, year — неотрицательный int
  (верхняя граница year = текущий год + 1 — динамическая, остаётся в сервисе;
  то же для доменных проверок: isbn-уникальность, stock-vs-reserved, состояния
  резервов).
- Правило соответствия то же, что в auth: доменные проверки могут остаться в
  сервисе, но совпадающие правила не должны расходиться.

### Acceptance criteria

- Существующие e2e на `INVALID_ARGUMENT` (`limit > 100`, пустые обязательные
  поля, `amount < 1`) остаются зелёными.
- Валидация срабатывает до доменной логики: невалидный `limit` не делает
  запроса к репозиторию (unit с моком или e2e по отсутствию side-effects).
- `UpdateBook` без единого изменяемого поля — поведение как сейчас (не
  регрессировать; если сейчас no-op → так и остаётся).

### Out of scope

- Полный перенос доменной валидации в DTO; валидация внутренних RPC-схем
  вне контроллера.
