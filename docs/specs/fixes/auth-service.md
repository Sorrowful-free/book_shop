# Fixes: auth-service

> Статус: done | Модуль: `apps/auth-service` (+ `packages/common` для
> общего загрузчика секретов)

## F-A1. GC для `refresh_tokens`

### Проблема

Таблица `refresh_tokens` растёт монотонно: ни rotation, ни revoke, ни истечение
`expires_at` не удаляют строки. Отозванные и давно истёкшие токены не нужны
ни для чего — старый jti не может быть ни принят (revoked), ни использован
(сам JWT протух); строка нужна только пока токен потенциально активен, плюс
короткий audit-хвост на случай replay-расследования.

### Ожидаемое поведение

- В auth-service есть периодический sweeper (по образцу
  `ReservationSweeper` в catalog-service: `setInterval` в `onModuleInit`,
  `timer.unref()`, остановка в `onModuleDestroy`, ошибки sweep логируются и
  не роняют процесс).
- На каждом тике sweeper удаляет строки `refresh_tokens`, у которых
  `expires_at < now - RETENTION`. Удаляются и revoked, и не-revoked, но
  давно истёкшие — критерий только возраст истечения.
- Retention конфигурируется env `REFRESH_TOKEN_AUDIT_TTL_SEC` (дефолт 7
  дней = 604800). Интервал — `REFRESH_TOKEN_SWEEP_INTERVAL_SEC`
  (дефолт 3600).
- Строки, у которых `expires_at` ещё не вышел или вышел менее RETENTION
  назад, НЕ трогаются — рабочая семантика rotation/revoke не меняется.

### Acceptance criteria

- Given в БД строка с `expires_at` старше `now - RETENTION` → после одного
  `sweep()` её нет.
- Given строка, истёкшая < RETENTION назад, и строка не истёкшая → после
  `sweep()` обе на месте.
- Unit-тест метода sweep на in-memory/моке; e2e — опционально, достаточно
  unit + интеграционной проверки, что sweeper зарегистрирован и останавливается
  на shutdown (процесс теста не виснет).

### Out of scope

- Удаление по revoked_at — истёкшие-не-отозванные строки тоже уходят по TTL.
- Архивирование в отдельную таблицу.

## F-A2. Ленивый hash в seedAdmin

### Проблема

`seedAdmin()` вызывает `hashPassword()` (argon2id, десятки мс CPU) при каждом
запуске, даже когда admin уже существует и результат хэша выбрасывается
(`upsert` с `update: {}`).

### Ожидаемое поведение

- `seedAdmin` сначала проверяет существование пользователя
  (`findUnique`/`findUserByName`); хэш пароля вычисляется ТОЛЬКО когда admin
  отсутствует и его нужно создать.
- Существующий admin не перезаписывается (поведение `upsert {update:{}}`
  сохраняется).

### Acceptance criteria

- Given существующий admin → boot не выполняет argon2-хэширование
  (доказуемо: spy/mock на `hashPassword` в unit-тесте, либо отсутствие
  вызова по счётчику).
- Given отсутствующий admin → создаётся с хэшем из `SEED_ADMIN_PASSWORD`,
  login работает (существующий e2e-тест «seeds the admin» остаётся зелёным).

### Out of scope

- Ротация пароля admin через env.

## F-A3. Загрузка JWT-ключей из файлов (`*_FILE` env)

### Проблема

PEM-ключи передаются только inline-env (`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`).
PEM содержит `\n` и хрупок в env-файлах/docker secrets. Стандартный приём —
`*_FILE`-переменная с путём к файлу (docker secrets convention).

### Ожидаемое поведение

- В `packages/common` появляется helper `resolveSecret(name): string`
  (или эквивалентный по названию): если задана `process.env[`${name}_FILE`]`
  — читает файл (`node:fs.readFileSync`, utf8, срезает trailing newline);
  иначе возвращает `process.env[name]`. Файл имеет приоритет над inline
  значением, когда обе заданы (явно задокументировать).
- Нечитаемый/несуществующий файл → выбрасывает Error с именем env-переменной
  и путём (содержимое НЕ включается в сообщение).
- auth-service использует helper для `JWT_PRIVATE_KEY` и `JWT_PUBLIC_KEY`;
  catalog-service и cart-service — для `JWT_PUBLIC_KEY` (их `app.module`
  читают её через тот же helper).
- Пустая `*_FILE` ("" или whitespace) трактуется как незаданная.

### Acceptance criteria

- Unit-тесты helper'а: file-variant отдаёт содержимое; приоритет файла над
  inline; отсутствие обеих → ошибка/undefined по контракту helper'а;
  битый путь → Error с именем переменной.
- Сервисы стартуют с `*_FILE` вместо inline-значений (минимум один e2e/
  bootstrap-тест или unit на модуль-фабрики).
- `.env.example` и README обновлены.

### Out of scope

- Vault/secrets-manager интеграции, hot-reload ключей.

## F-A4. Boundary-валидация запросов (class-validator)

### Проблема

Валидация формы запроса (user_name regex, password ≠ пустой и т.п.) сейчас
размазана по `AuthService` вперемешку с доменной логикой. Зависимости
`class-validator`/`class-transformer` уже в `package.json`, но не
используются.

### Ожидаемое поведение

- На границе gRPC-контроллера (`AuthController`) входящие сообщения
  валидируются DTO-классами с декораторами class-validator: `Register`,
  `Login`, `Refresh`, `RevokeToken`, `ValidateToken`, `GetUser`.
- Покрываются СТАТИЧЕСКИЕ ограничения формы: типы, обязательность,
  `user_name` ~ `^[A-Za-z0-9_]{3,32}$`, непустые токены/id. Доменные
  правила (политика сложности пароля, проверки по БД) остаются в сервисе.
- Нарушение DTO → `INVALID_ARGUMENT` (через `ValidationPipe` с
  `exceptionFactory`, возвращающей `RpcException {code,message}` — см.
  существующий `rpcError`-паттерн; тело может нести детали полей).
- Дублирующие проверки формы в `AuthService` могут остаться как
  defense-in-depth — их удаление не требуется, но и дрейф двух источников
  истины недопустим: правило в DTO и в сервисе обязано совпадать.

### Acceptance criteria

- Существующие e2e на `INVALID_ARGUMENT` (слабый пароль, плохой user_name)
  остаются зелёными — либо обновляются, если сообщение поменялось, но код
  тот же.
- `ValidateToken({access_token: ""})` и подобные пустые обязательные поля →
  `INVALID_ARGUMENT` на границе, до вызова сервиса.
- Unit-тест или e2e: валидация срабатывает до доменной логики (например,
  невалидный user_name с валидным паролем не вызывает обращение к
  репозиторию — проверяется моком).

### Out of scope

- Замена существующей сервисной валидации целиком; кастомные
  cross-field валидаторы.
