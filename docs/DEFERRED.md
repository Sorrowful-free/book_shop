# Deferred work — техдолг и отложенные улучшения

Известные проблемы и улучшения, которые **осознанно отложены**. Каждая запись:
что, почему отложено, когда возвращаться. Не баги — весь реализованный функционал
зелёный (`441/441` тестов), это качество/поддерживаемость/эксплуатация.

> Ревизия 2026-10: T1/T2/T3-part, C3, C6, D1, G3, G5, G8 закрыты cleanup-коммитом
> (test:unit/test:e2e скрипты, правила в AGENTS.md, partitioner, статусы спек).
> Заодно исправлены: `ReserveStock` без `details` (spec §2), `JwtVerifier`
> принимал access-токены без `jti` (неотзываемые), `getCart` продлевал TTL
> corrupt-ключа, путь к `gen-keys` в `.env.example` catalog/cart.
>
> Ревизия 2026-10 (order-service, план 04): реализован по спеке 04 + fix-спеки
> F-O1..F-O5 (order), F-C4 (catalog `reservationStatus` в details), F-K4
> (cart — декремент позиций по `goods[]` вместо whole-cart clear). Закрыты
> C1 (`requestValidationPipe` → `@book-shop/common` + миграция трёх сервисов)
> и C7 для order (`keyField: "userId"`); G9 частично. Новое: C9 — общий
> rpcError с `error-details`-trailer кандидат в common.
>
> C1 закрыт: `requestValidationPipe` вынесен в `@book-shop/common`
> (`src/rpc-validation-pipe.ts`), auth/catalog/cart переведены на общий
> pipe — семантика идентична (INVALID_ARGUMENT + top-level `code`),
> flatten `children` для `@ValidateNested` сохранён.

## Тесты / CI

### T3. `TimeoutNegativeWarning` в логах e2e
В прогонах auth e2e видно `TimeoutNegativeWarning: -1791832353064 is a
negative number. Timeout duration was set to 1` — похоже на kafkajs/Nest
таймер с кривым значением (гигантское отрицательное число). На результаты
не влияет, источник не найден.
**Когда:** при первом проявлении реальных таймаут-проблем в тестах.

## Код / архитектура

### C2. Дублирование sweeper-паттерна
`RefreshTokenSweeper` (auth) и `ReservationSweeper` (catalog) — одинаковый
lifecycle: `onModuleInit/Destroy`, `unref`'d `setInterval`, лог ошибок,
конфиг интервала. Можно обобщить до `PeriodicSweeper` в `common`, сервисы
оставят только `sweep()`.
**Когда:** с третьим sweeper'ом (order-service?) или при правках логики
таймера, которую придётся портировать в два места.

### C4. `@IsUUID()` строже сервисного regex (cart)
Boundary DTO принимает только RFC-valid UUID, сервисный `CART_ID_RE` —
произвольный hex-формат (case-insensitive). Для v4-uuid'ов из `randomUUID()`
совпадает, но если когда-либо понадобятся uuid v1/v5/nil — поведение
разойдётся.
**Когда:** только если изменится формат `cart_id` в контракте.

### C5. `extractable: true` для Ed25519 private key (auth `tokens.ts`)
Ключ экспортируется в `CryptoKey` с `extractable: true` — нужен для
`exportJWK`→`importJWK` вывода публичного из приватного. Лежит
экстрактабельным в памяти процесса. Можно: импортировать private non-
extractable, а public подавать отдельным env (он и так есть —
`JWT_PUBLIC_KEY`).
**Когда:** при hardening-итерации; для учебного проекта приемлемо.

### C8. `@Ctx()`-правило без lint-гарантии
AGENTS.md требует `@Ctx()` на gRPC-методах, читающих metadata (баг-класс уже
кусался: `GetUser` терял metadata). Правило doc-only; механизация — custom
ESLint-правило «metadata-параметр без `@Ctx()`», medium effort (анализ
декораторов NestJS-контроллеров).
**Когда:** при следующей потере metadata в gRPC-методе или при появлении
лёгкого способа (eslint-plugin-nestjs?).

### C7. Детерминированный kafka-key не для всех событий
`key = userId` покрывает `auth.user.*`, `key = bookId` — `catalog.book.*`.
Решено для order (2026-10): `order.order.*` тоже `key = userId` — per-user
ordering включает per-order (created→paid→cancelled по заказам одного
пользователя не перемешивается) и совпадает с ожиданием cart e2e.
События без очевидного entity-id (или с составным) могут разъезжаться по
партициям → нет ordering-гарантии по сущности.
**Когда:** при добавлении новых типов событий без user/entity-id в payload.

### C9. rpcError + error-details trailer дублируется в сервисах
`rpcError` локален в каждом сервисе; order-service и catalog теперь
дублируют логику «details → `error-details` Metadata-trailer» (единственный
канал, который grpc-js `serverErrorToStatus` пропускает для структурных
данных). Кандидат на вынос в `@book-shop/common` рядом с
`requestValidationPipe` (общий конструктор `RpcException` с code+trailers).
**Когда:** при следующей правке rpcError в двух местах или появлении
пятого сервиса (api-gateway не считается — он HTTP).

## Конфигурация / эксплуатация

### O1. Docker-образы для сервисов
`infra/docker-compose.yml` поднимает только инфру (postgres/redis/kafka/
kafka-ui). Сами сервисы запускаются локально `bun run start`. Для полного
`docker compose up`-деплоя нужны Dockerfile на каждый app + healthchecks.
**Когда:** этап деплоя/демонстрации после gateway+web.

### O2. `seedAdmin` findUnique→upsert — микро-TOCTOU
Между `findUnique` (админ есть?) и `upsert` есть окно: два параллельных
инстанса на холодном старте оба пройдут проверку. `upsert` всё равно
безопасен по unique-индексу, второй просто перепишет — но при кастомном
create-объекте может быть лишняя запись лога/конфликт.
**Когда:** низкий приоритет; вспомнить при HA-деплое auth.

## Пробелы в покрытии

### G1. Refresh-token GC покрыт только unit-тестами
`RefreshTokenSweeper.sweep` + `deleteExpiredRefreshTokens` проверены на
in-memory дубле и spec-файле — но нет e2e против реального Postgres,
который доказал бы, что `deleteMany({expiresAt: {lt: cutoff}})` действительно
чистит таблицу и что sweeper живёт в модуле (init → tick → destroy).
**Когда:** при ближайшем расширении auth e2e.

### G2. `resolveSecret` / `*_FILE` — только unit-тесты
Чтение секрета из файла покрыто `secrets.spec.ts`, но нет ни одного
прогона, где сервис реально стартует с `JWT_*_FILE` — ни e2e, ни
compose-сценария. Ошибки в wiring (неверное имя переменной, путь) поймает
только ручной запуск.
**Когда:** при настройке docker-secrets/деплоя (см. O1).

### G7. `seedAdminUser` после рефакторинга потерял часть покрытия
При уходе от `mock.module` спека теперь тестирует чистую функцию
`seedAdminUser`, но **не** связку `AppModule.onModuleInit` → `seedAdmin()`
→ `relay.start()` — т.е. то, что env-переменные `SEED_ADMIN_*` вообще
дочитываются в функцию, ничто не проверяет.
**Когда:** при правках `onModuleInit` — добавить тест на wiring.

### G9. Cart Kafka-consumer не имеет e2e на реальном `order.order.created`
Частично закрыто (2026-10): продюсер появился — order-service шлёт
`order.order.created` через outbox, а cart e2e проверяет F-K4-семантику
(декремент позиций по `goods[]`) тестовым producer'ом. Осталось нереальным
только сквозное «order.Checkout → Kafka → cart» — это осознанно отнесено
к сквозному e2e (Plan 7), где сервисы подняты вместе.
**Когда:** Plan 7 (интеграционный e2e).

## Процесс

### G4. Фоновые сабагенты не могли выполнить проверки
Все три фикс-агента отчитались, что `bun test`/`lint`/`typecheck` в их
окружении недоступны — верификацию гоняла родительская сессия. Если это
предел среды сабагентов, то любой «агент реализует + сам проверяет» —
нереалистичен: проверка всегда ложится на оркестратора.
**Когда:** учитывать при планировании следующих агентов (order-service) —
закладывать явный этап верификации у родителя.

## Проверено и оставлено как есть (ревизия 2026-10)

Спорные места из ревью, по которым принято решение **не менять** код:

- **`UpdateBook` без единого поля → `book.updated` + bump `updated_at`.**
  Осознанно: fix-спека F-C3 прямо требует «поведение как сейчас, не
  регрессировать». Если когда-нибудь появится требование no-op — отдельная
  спека и изменение контракта.
- **Повторный `DeleteBook` → второй `book.deleted` в outbox.** Дубликат
  безобиден: доставка at-least-once уже обязывает консьюмеров быть
  идемпотентными, а спека не определяет ошибку для этого случая. Менять —
  значит расширять контракт (FAILED_PRECONDITION) или молча подавлять
  событие; оба варианта хуже статус-кво.
- **`apps/catalog-service/test/helpers.ts` в `test/` вместе с e2e.** Это
  unit-test kit, но `bun test` подбирает только `*.spec.ts` — файл никогда
  не запустится как тест и не попадёт в `test:e2e`. Переезд не нужен.
