# Fixes: order-service

> Статус: done | Модуль: `apps/order-service`
>
> Решения, принятые при ревью спеки `docs/specs/04-order-service.md` перед
> реализацией. Каждый пункт — отклонение или уточнение базовой спеки;
> реализуются вместе с order-service в том же плане.

## F-O1. `CommitStock` → `FAILED_PRECONDITION` (`insufficient_stock`)

### Проблема

`catalog.CommitStock` имеет третий исход помимо «ok» и `NOT_FOUND`:
`insufficient_stock` → `FAILED_PRECONDITION`. Резерв гарантирует доступность
только на момент `ReserveStock` — `UpdateBook` ставит абсолютный `stock` и
может уронить остаток под живым резервом; guarded decrement тогда отказывается
уходить в минус. Спека 04 этот исход не описывает — заказ завис бы в PENDING
навсегда (резерв ACTIVE, commit невозможен).

### Ожидаемое поведение

- `FAILED_PRECONDITION` от `CommitStock` обрабатывается как «заказ
  невыполним»: заказ → `CANCELLED` (+`cancelled_at`) в одной транзакции с
  outbox-записью `order.cancelled`, caller получает `FAILED_PRECONDITION`.
- Дополнительно делается best-effort `ReleaseStock(reservation_id)` — резерв
  в этот момент ещё `ACTIVE`, релиз освобождает availability. Ошибка релиза
  (`NOT_FOUND` — успел протухнуть) игнорируется, исход заказа не меняется.

### Acceptance criteria

- `CommitStock` → `FAILED_PRECONDITION` на PENDING-заказе → caller получает
  `FAILED_PRECONDITION`, заказ в БД `CANCELLED`, в outbox — `order.cancelled`,
  `ReleaseStock` вызван один раз.
- Юнит-тест: мок CommitStock бросает FP → весь путь выше воспроизводится.

### Out of scope

- Ретрай PayOrder в надежде на пополнение stock (заказ уже CANCELLED —
  терминален); отдельный код ошибки «невыполним».

## F-O2. CancelOrder crash-gap: self-heal через `reservationStatus` в details

### Проблема

Базовая спека: `ReleaseStock` → `FAILED_PRECONDITION` считается успешной
компенсацией, заказ → `CANCELLED`. Но `FAILED_PRECONDITION` покрывает два
терминальных состояния резерва — `COMMITTED` и `RELEASED` (см. fix-спеку
catalog F-C4 — статус теперь приезжает в `details.reservationStatus`).
`RELEASED` → `CANCELLED` корректно (цель достигнута). `COMMITTED` →
`CANCELLED` оставлял фантом: stock списан, оплата не отражена, `order.paid`
не опубликован.

### Ожидаемое поведение

- `CancelOrder` на PENDING-заказе: `ReleaseStock` успех или `NOT_FOUND` →
  `CANCELLED` + `order.cancelled` (как спека).
- `ReleaseStock` → `FAILED_PRECONDITION` с `details.reservationStatus`:
  - `"RELEASED"` → `CANCELLED` + `order.cancelled` (компенсация уже была).
  - `"COMMITTED"` → self-heal: заказ → `PAID` (`paid_at = now`) в одной
    транзакции с outbox-записью `order.paid`; caller получает заказ со
    статусом `PAID` — реальность (stock погашен) отражается честно.
  - details отсутствуют/нераспознаны (старый catalog) → `CANCELLED` —
    консервативный фоллбэк базовой спеки.
- PAID/CANCELLED-заказ → `FAILED_PRECONDITION` (без изменений).

### Acceptance criteria

- Стаб `ReleaseStock` бросает FP с `reservationStatus: "COMMITTED"` → заказ
  `PAID`, outbox содержит `order.paid`, `order.cancelled` отсутствует.
- `reservationStatus: "RELEASED"` и FP без details → `CANCELLED` +
  `order.cancelled`.
- Юнит-тесты на все три ветки + e2e со стабом catalog.

### Out of scope

- Отдельный `GetReservation` RPC; изменение кодов ошибок catalog (достаточно
  details).

## F-O3. PayOrder идемпотентен на PAID-заказе

### Проблема

Спека §9: повторный `PayOrder` → `FAILED_PRECONDITION`. При потерянном
ответе (commit прошёл, ответ не дошёл) ретрай клиента получает ошибку,
хотя цель достигнута — неидемпотентная семантика для «денежного» RPC.

### Ожидаемое поведение

- `PayOrder` на заказе со статусом `PAID` → возвращает заказ (без повторного
  `CommitStock` — заказ уже оплачен, вызов catalog не нужен).
- `PayOrder` на `CANCELLED` → `FAILED_PRECONDITION` (отмена терминальна).
- `PENDING` → обычный путь (`CommitStock` идемпотентен сам по себе —
  ретрай после падения persist безопасен, как в спеке).

### Acceptance criteria

- `PayOrder` → `PAID`; повторный `PayOrder` → тот же заказ `PAID`, catalog
  не вызывался повторно, outbox не получил второй `order.paid`.
- `PayOrder` на CANCELLED → `FAILED_PRECONDITION`.

### Out of scope

- Идемпотентность CancelOrder (повторная отмена → `FAILED_PRECONDITION` —
  как спека).

## F-O4. Pass-through деталей ошибок catalog

### Проблема

`ReserveStock` возвращает `FAILED_PRECONDITION` + `{unavailableBookIds}` и
`NOT_FOUND` + `{missingBookIds}` — catalog писал details специально «so
order-service can map them back to cart positions». Базовая спека не
уточняет, доезжают ли details до caller'а.

### Ожидаемое поведение

- Ошибки зависимых вызовов cart/catalog пробрасываются caller'у с
  сохранением `code`, `message` и структурированных `details` — без
  переврапления в безликий `INTERNAL`/`UNAVAILABLE`. Маппинг «зависимость
  недоступна» (`UNAVAILABLE`) применяется только к транспортным ошибкам
  (connection refused, deadline), не к доменным ответам зависимости.
- То же для `GetBooksByIds` `NOT_FOUND` (книга не найдена).

### Acceptance criteria

- Стаб catalog бросает FP с `{unavailableBookIds: ["b1"]}` → caller получает
  `FAILED_PRECONDITION` и в details видит `unavailableBookIds`.
- Юнит-тест на проброс details; e2e на checkout по недоступной книге.

### Out of scope

- Трансформация details в другой формат; локализация message.

## F-O5. Детерминированный порядок выдачи

### Проблема

Спека задаёт offset/limit для `ListMyOrders`, но не порядок сортировки;
`order_items` не имеет колонки порядка — порядок `items` в ответе
недетерминирован.

### Ожидаемое поведение

- `ListMyOrders`: `ORDER BY created_at DESC, id DESC` (новейшие первыми,
  стабильный tiebreak по id — курсоро-независимая пагинация).
- `items` в `Order` (GetOrder/ListMyOrders/Checkout-ответ): `ORDER BY
  book_id ASC` — детерминизм без новой колонки.

### Acceptance criteria

- e2e: два заказа → `ListMyOrders` выдаёт новейший первым; повторный запрос
  даёт тот же порядок items.

### Out of scope

- Курсорная пагинация; сортировка по другим полям.
