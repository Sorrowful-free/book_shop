# Fixes: cart-service

> Статус: approved | Модуль: `apps/cart-service` (+ опциональная правка
> `packages/common` при наличии общих helpers)

## F-K1. MergeCart при битой guest-корзине

### Проблема

`repository.get()` возвращает `null` и для отсутствующего, и для **corrupt**
ключа (`JSON.parse` упал → «missing»). В `mergeCart` corrupt-ветка попадает в
`if (guest)` = false → гостевой ключ **не удаляется** и висит до TTL; юзер при
повторных merge получает то же «пустое» поведение без диагностики.

### Ожидаемое поведение

- При `mergeCart` ключ гостевой корзины удаляется всегда, когда он существует —
  в том числе если хранимое значение не парсится. Corrupt-пейлоад вносит 0
  позиций.
- Семантика остальных веток не меняется: missing guest → no-op success; merge
  атомарен (`setAndDelete` / MULTI).
- Предпочтительный приём: репозиторий различает «missing» и «corrupt» (напр.
  `get` возвращает сентинел/второй признак, либо merge использует
  `get`-сырец + безусловный `DEL` в транзакции). Реализация на усмотрение
  исполнителя при соблюдении контракта.

### Acceptance criteria

- Given guest-ключ существует с невалидным JSON → `mergeCart` возвращает
  юзер-корзину без изменений и гостевой ключ УДАЛЁН (проверяется прямым `GET`
  в e2e или состоянием репозитория в unit).
- Given missing guest → поведение как раньше (no-op success, юзер-корзина
  нетронута, DEL не обязателен).
- Существующий тест «merge sums + deletes guest» зелёный.

### Out of scope

- Восстановление/миграция corrupt-пейлоадов; логирование уровня warn — по
  желанию, не обязательно.

## F-K2. Переполнение `amount` при накоплении

### Проблема

`addItem` делает `existing.amount += request.amount`. `amount` на проводе —
int32, но сумма в JSON хранится без типа и может превысить 2 147 483 647
(многократные addItem). При ответе ts-proto/encoder на `int32` поле такого
значения поведение не определено (урезание/ошибка сериализации → `UNKNOWN`
либо молча битый ответ).

### Ожидаемое поведение

- Результирующая сумма `amount` по позиции ДОЛЖНА быть ≤ 2 147 483 647;
  превышение → `INVALID_ARGUMENT` (`"amount would overflow int32"` или
  аналогичное сообщение), состояние корзины не мутируется.
- Та же граница применяется при merge (сумма гость+юзер > max →
  `INVALID_ARGUMENT`, merge не выполняется, обе корзины нетронуты).

### Acceptance criteria

- Given в корзине позиция с amount, близким к int32 max → `addItem` со
  значением, переполняющим сумму, → `INVALID_ARGUMENT`; корзина не изменилась.
- Given merge, где сумма по позиции переполняет int32 → `INVALID_ARGUMENT`;
  guest-ключ остаётся (merge не произошёл).
- Unit-тесты на обе границы.

### Out of scope

- Отдельный код ошибки для переполнения (достаточно `INVALID_ARGUMENT`).

## F-K3. Boundary-валидация запросов (class-validator)

### Проблема

Как в остальных сервисах: проверки формы (uuid-формат `cart_id`,
обязательность `book_id`, знак `amount`) сидят в `CartService`.
Дополнительно: у cart-service **нет** зависимостей `class-validator`/
`class-transformer` — их нужно добавить теми же версиями, что у соседей
(`^0.14.1`, `^0.5.1`).

### Ожидаемое поведение

- DTO + `ValidationPipe` (exceptionFactory → `RpcException` с
  `INVALID_ARGUMENT`) на методах `CartController`: `GetCart`, `AddItem`,
  `UpdateItem`, `RemoveItem`, `ClearCart`, `MergeCart` (`CreateCart` не
  принимает входных полей — может не иметь DTO).
- Статические ограничения: `book_id` непустой, `amount` int ≥ 0 (для
  `AddItem` ≥ 1), uuid-формат для `cart_id`/`guest_cart_id`.
- ВАЖНО (семантика, зафиксированная прошлым ревью): presence-check `cart_id`
  (`!== undefined`) — не truthiness. `cart_id: ""` — невалидное значение
  (`INVALID_ARGUMENT`), а не «user-cart path». DTO-валидация обязана
  сохранить это различие: опциональное поле отсутствует → не проверяется,
  присутствует пустым → ошибка.
- Регистрозависимая нормализация (lowercase) — может остаться в сервисе
  (это не форма, а нормализация); либо `@Transform` в DTO — на усмотрение
  при сохранении поведения.

### Acceptance criteria

- Все существующие unit+e2e на `INVALID_ARGUMENT`/`UNAUTHENTICATED` остаются
  зелёными (в т.ч. `cart_id: ""` → `INVALID_ARGUMENT`, верхний регистр uuid →
  та же корзина).
- Невалидный запрос не достигает репозитория (unit с моком).

### Out of scope

- Замена всех ручных проверок в сервисе; валидация ответов.
