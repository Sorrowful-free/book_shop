# Deferred work — техдолг и отложенные улучшения

Известные проблемы и улучшения, которые **осознанно отложены**. Каждая запись:
что, почему отложено, когда возвращаться. Не баги — весь реализованный функционал
зелёный (`340/340` тестов), это качество/поддерживаемость/эксплуатация.

## Тесты / CI

### T1. Разделить `bun test` на unit и e2e
Сейчас единый `bun test` требует живой инфры (postgres/redis/kafka) — e2e
падают без неё. Для CI и локальных unit-прогонов нужны отдельные скрипты,
например `test:unit` (`src/**/*.spec.ts`) и `test:e2e` (`apps/*/test/`),
плюс `infra:up` перед e2e в CI.
**Когда:** при настройке CI или когда unit-прогоны начнут раздражать.

### T2. `mock.module` — глобальная утечка между тест-файлами
`bun test` шарит процесс и реестр модулей между файлами: `mock.module()` из
одного `*.spec.ts` ломает код других файлов (уже кусались — мок
`./password` выдавал `verifyPassword → false` и `isPasswordValid → true`
в auth e2e). Правило: **не использовать `mock.module`**, предпочитать DI
(как `seedAdminUser` с инъектируемым `hash`) или локальные спаи.
**Когда:** добавить в `AGENTS.md` как правило написания тестов; пересмотреть
при обновлении Bun (обещают per-file scoping).

### T3. `TimeoutNegativeWarning` в логах e2e
В прогонах auth e2e видно `TimeoutNegativeWarning: -1791832353064 is a
negative number. Timeout duration was set to 1` — похоже на kafkajs/Nest
таймер с кривым значением (гигантское отрицательное число). На результаты
не влияет, источник не найден.
**Когда:** при первом проявлении реальных таймаут-проблем в тестах.

## Код / архитектура

### C1. Дублирование `requestValidationPipe` в трёх сервисах
`auth.dto.ts`, `catalog-service/src/dto.ts`, `cart-service/src/dto.ts` —
три почти идентичных `ValidationPipe` с `RpcException` + `code` фабрикой.
Кандидат на вынос в `@book-shop/common` (как `JwtVerifier`/`OutboxRelay`).
**Когда:** при появлении четвёртого потребителя (order-service) — уже
реальный сигнал, а не преждевременная абстракция.

### C2. Дублирование sweeper-паттерна
`RefreshTokenSweeper` (auth) и `ReservationSweeper` (catalog) — одинаковый
lifecycle: `onModuleInit/Destroy`, `unref`'d `setInterval`, лог ошибок,
конфиг интервала. Можно обобщить до `PeriodicSweeper` в `common`, сервисы
оставят только `sweep()`.
**Когда:** с третьим sweeper'ом (order-service?) или при правках логики
таймера, которую придётся портировать в два места.

### C3. `@Ctx()` — обязательный декоратор для `metadata`
Ловушка: как только в gRPC-методе есть `@Payload`, недекорированные
аргументы перестают получать `Metadata` — `metadata` приходит `undefined`,
caller = null, всё `UNAUTHENTICATED` (уже отловлено в auth). Сейчас страхует
только ревью.
**Когда:** документировать в `AGENTS.md`/`docs` для order-service и
будущих сервисов; в идеале — кастомный lint-правило или codegen-чек.

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

### C6. KafkaJS v2 default partitioner warning
`KafkaJS v2.0.0 switched default partitioner` — предупреждение в логах.
Семантика ключей у нас осознанная (`key = userId/bookId`), но partitioner
сменился на murmur2 — для учебного проекта безразлично. Глушится
`KAFKAJS_NO_PARTITIONER_WARNING=1` или явным `createPartitioner:
Partitioners.LegacyPartitioner`.
**Когда:** при оформлении логирования/деплоя, чтобы не мусорить в логах.

### C7. Детерминированный kafka-key не для всех событий
`key = userId` покрывает `auth.user.*`, `key = bookId` — `catalog.book.*`.
События без очевидного entity-id (или с составным) могут разъезжаться по
партициям → нет ordering-гарантии по сущности.
**Когда:** при добавлении новых типов событий (order events — проверить,
что `key = orderId` или `userId` — что важнее для консьюмеров).

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

## Пробелы после фикс-раунда (что не доделано / не проверено)

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

### G3. Cart `mergeCart` e2e не покрывает corrupt-guest на Redis-уровне
Unit покрывает `lookup → corrupt → setAndDelete`, e2e-кейс с реально
битым JSON в Redis-ключе (`SET cart:guest:x "not-json"`) не написан —
именно он был бы лучшей регрессией для F-K1.
**Когда:** следующая правка cart e2e.

### G4. Фоновые сабагенты не могли выполнить проверки
Все три фикс-агента отчитались, что `bun test`/`lint`/`typecheck` в их
окружении недоступны — верификацию гоняла родительская сессия. Если это
предел среды сабагентов, то любой «агент реализует + сам проверяет» —
нереалистичен: проверка всегда ложится на оркестратора.
**Когда:** учитывать при планировании следующих агентов (order-service) —
закладывать явный этап верификации у родителя.

### G5. `bun.lock` правился вручную агентом
Cart-агент добавил `class-validator`/`class-transformer` в `bun.lock`
рукой (не `bun add`). `bun install` подтвердил «no changes» — правка
оказалась корректной, но способ хрупкий: при расхождении хэшей локфайл
мог лечь.
**Когда:** правило для будущих агентов — зависимости только через
`bun add`, локфайл не редактировать.

### G6. `TimeoutNegativeWarning` не исправлен
См. T3 — источник так и не найден, заметили случайно в логах e2e.

### G7. `seedAdminUser` после рефакторинга потерял часть покрытия
При уходе от `mock.module` спека теперь тестирует чистую функцию
`seedAdminUser`, но **не** связку `AppModule.onModuleInit` → `seedAdmin()`
→ `relay.start()` — т.е. то, что env-переменные `SEED_ADMIN_*` вообще
дочитываются в функцию, ничто не проверяет.
**Когда:** при правках `onModuleInit` — добавить тест на wiring.

### G8. `docs/specs/fixes/` — спеки отработаны, статуса нет
Все три fix-спеки (`docs/specs/fixes/*.md`) реализованы и проверены, но
файлы не помечены как completed — висят без статуса, при повторном чтении
можно подумать, что работа открыта.
**Когда:** добавить `Status: done` в заголовки при ближайшем коммите.

### G9. Cart Kafka-consumer не имеет e2e на реальном `order.order.created`
Consumer подписан на `order.order.events` (group `cart-service`), но сам
order-service не реализован — ничто не продюсит это событие, и e2e
«publish → cart cleared» невозможен до появления продюсера (или тестового
producer'а в самом e2e).
**Когда:** order-service (план 04) или standalone-тест с KafkaProducer.

## Документация

### D1. Синхронизировать `AGENTS.md` с новыми правилами
Добавить туда: запрет `mock.module` (T2), правило `@Ctx()` (C3),
соглашение `resolveSecret`/`*_FILE`, правило `code` на `RpcException`.
Сейчас это разбросано по комментариям в коде.
**Когда:** перед стартом order-service — туда пойдёт новый сабагент.
