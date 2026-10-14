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

### T4. `(unnamed)`-фейлы в e2e = упавший `beforeAll`, почти всегда инфра
bun репортит бросок из `beforeAll`/`afterAll` как `(fail) <describe> >
(unnamed)` и **не считает** тесты describe в итоговом счётчике — поэтому
прогон с упавшими хуками показывает меньше тестов (CI run 38399756517:
419 вместо 446). Подтверждённые источники: `docker compose up --wait`
помечает one-shot `kafka-init` «healthy» при старте, не при завершении →
первый consumer получал `UNKNOWN_TOPIC_OR_PARTITION` (чинится `docker
compose wait kafka-init` после up); недоступный Kafka →
`KafkaJSConnectionError` в `startAllMicroservices`. Диагноз: сначала
`docker compose ps` + healthcheck + лог kafka-init, потом код.
**Когда:** пересмотреть, если появится `waitForInfra`-хелпер в e2e-хуках.

### T5. e2e-файлы делят один процесс: утечки и порты влияют кросс-файлово
Файлы e2e биндят реальные порты; cart TTL-дескрайб конфликтовал по :50083
с catalog-стабом order.e2e — при падении cart-хука зомби-сервер держал
порт и валил следующий файл (EADDRINUSE, CI run 38399756517). Частично
снято: startApp в e2e теперь закрывает частично поднятое приложение при
броске, порты разведены. Остаётся: тестовый consumer cart работает в
боевой группе `cart-service` — параллельный dev-инстанс может забирать
`order.order.created` у теста (флак по таймауту ожидания); test-consumer'ы
уже уникальны (`catalog-e2e-*`, `order-e2e-*`), app-consumer — нет.
**Когда:** если e2e начнут флакать при поднятых dev-сервисах — уникализиро-
вать groupId приложения в тестах (`cart-service-${randomUUID()}`).

### T7. `bun run proto:lint` красный на main и не в CI
buf `STANDARD` фейлится на старой схеме каталога proto/: `PACKAGE_DIRECTORY_MATCH`
(плоская раскладка вместо `bookshop/<svc>/v1/`) и `RPC_RESPONSE_STANDARD_NAME`
(shared `Cart`/`Order` response-типы у нескольких RPC). Проверка существует,
но молча сломана и не подключена к CI — регрессии контрактов не ловятся.
Дешёвый фикс: `lint.except` для этих двух правил в `packages/contracts/buf.yaml`
→ добавить шаг в workflow. Полный фикс: реструктуризация каталогов + переименование
response-типов (рябит на все gen-стабы и сервисы).
**Когда:** при следующем расширении proto-контрактов — сначала
except+CI, потом по желанию реструктуризация.

### T6. Нет браузерного e2e для web (playwright)
Сквозные сценарии витрины (гостевая корзина → логин → merge → checkout →
pay → /orders, admin CRUD) проверены только вручную curl'ом через proxy и
существующими backend-e2e. Браузерный e2e (playwright + поднятый стек)
отложен как отдельная задача (spec 06 §8 — «опционально»).
Живой случай уже был (2026-10, spec 08): `<img>`-путь через BFF ронял
`Cache-Control` у обложек — REST-e2e до gateway доходил, браузерный путь
не покрыт ничем.
**Когда:** перед демонстрацией / при первом регрессе в SSR-флоу.

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

### C10. Orphan-объекты в MinIO (обложки без владельца)
Загруженная обложка остаётся в `book-covers` навсегда, если книга не
сохранена, обложка заменена или книга удалена (spec 08 §12 — осознанно
отложено). Sweeper «объекты старше X без ссылки в `books.cover_url`»:
`listObjects` → анти-join по `cover_url LIKE '/api/v1/covers/%'` →
`removeObject`. Уместно рядом с `ReservationSweeper` в catalog-service
(и тогда же закроет паттерн из C2 — третий sweeper).
**Когда:** при росте bucket'а / перед демо-наполнением большим объёмом
загрузок; реализовывать по C2-обобщённому sweeper'у, если тот появится.

## Конфигурация / эксплуатация

### O1. Docker-образы для сервисов (включая web) — RESOLVED
Закрыто по спеке `docs/specs/07-docker.md` (approved): единый
`infra/docker/Dockerfile.service` (build-arg `APP`/`PRISMA_SCHEMA`,
`oven/bun:1` Debian) для бэкендов, двухстадийный
`infra/docker/Dockerfile.web` (`oven/bun:1` → `node:22-alpine`, nitro
`.output`), compose-профиль `apps` в `infra/docker-compose.yml` (gRPC-порты
не публикуются; снаружи только gateway :3000 и web :3001), docker-secrets
через `infra/scripts/gen-secrets.sh` → `infra/secrets/*.pem` (gitignored),
миграции `migrate deploy` + сид catalog в `infra/docker/entrypoint.sh`,
healthcheck'и и цепочка depends_on. Запуск: `bun run infra:secrets &&
bun run apps:up`.

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

### G4. Background-сабагенты не могут exec — правило диспетчеризации
Подтверждено дважды (fix-волна и order-service, план 04): в background
denied ВСЁ, включая `bun --version` и `mkdir` — агенты потратили ~8 вызовов
на обнаружение, вернули неверифицированный код (3 typecheck-ошибки, ~20
prettier-ошибок, stale `bun.lock`), разбор делал родитель.

Правило диспетчеризации:
- **Основной имплементер → foreground.** У foreground-агента exec
  запрашивает approval — он сохраняет verify-цикл (red-green до сдачи).
  Один большой артефакт без verify-цикла дороже последовательности.
- **Параллельные fix-агенты → background** — ок, их ошибки ловит
  верификация родителя между волнами.
- **Background-промпт всегда открывается preamble'ом** (см.
  `docs/specs/_implementer-prompt.md`): exec недоступен вообще — не
  пробовать; `write` создаёт каталоги сам; зависимости — править
  `package.json` руками и явно флагать в отчёте; форматирование не
  полировать — родитель прогонит `eslint --fix`.
- **У родителя — явный этап** после каждой волны: `bun install` (stale
  lockfile от hand-edit), `lint --fix`, `typecheck`, `test:unit`, e2e.
**Когда:** пересмотреть, если background-агенты получат exec — тогда
преамбула и правило foreground/background снимаются.

## Web / Nuxt под Bun (план 06)

### W1. Nuxt работает под Bun — оговорки окружения
В репозитории нет Node.js: все nuxt/nuxi команды идут через `bunx --bun`
(бинарники имеют `#!/usr/bin/env node`-shebang — прямой запуск упал бы).
Проверено: `dev`, `build`, `prepare`, `typecheck` (vue-tsc), `bun test`.
Известные косметические отклонения:
- `WARN [NUXT_B5010] tailwindcss/nesting could not be loaded` — резолвер
  bun не подхватывает подпуть `tailwindcss/nesting` из postcss-конфига
  `@nuxtjs/tailwindcss`; на наши стили не влияет (nested CSS не
  используется), tailwind-утилиты генерируются.
- Плагин `nuxt:devtools:config-retriever` предупреждает об ignored
  vite-хуках — devtools-фича, не влияет на SSR/proxy.
- Добавление/удаление файлов под `apps/web/server/plugins/` на работающем
  `dev` требует чистого рестарта (при необходимости `rm -rf apps/web/.nuxt`):
  устаревший виртуальный модуль плагинов иначе валит rebuild nitro или молча
  сохраняет старое поведение.
**Когда:** если появится node-runtime в CI/деплое — можно вернуться на
обычные `nuxt`/`nuxi` скрипты без `--bun`; если понадобится nested CSS —
установить `postcss-nesting` явно.

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
