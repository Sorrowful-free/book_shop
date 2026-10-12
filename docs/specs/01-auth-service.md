# 01. auth-service

> Статус: approved
> Proto: `packages/contracts/proto/auth.proto`
> Порт: `:50051` | Хранилище: PostgreSQL `auth_db` (user `auth_user`)

## 1. Ответственность и границы

Identity-сервис: владеет пользователями и учётными данными, выпускает и проверяет
токены. Единственный сервис, знающий приватный ключ подписи JWT.

Делает: регистрация, логин, refresh с ротацией, revoke, валидация access-token'а,
чтение профиля пользователя.
НЕ делает: авторизацию бизнес-операций других доменов, сессии фронтенда
(это web/gateway).

## 2. gRPC-контракт

Package `bookshop.auth.v1`, файл `packages/contracts/proto/auth.proto`:

| RPC            | Request                | Response                 | Ошибки                                     |
| -------------- | ---------------------- | ------------------------ | ------------------------------------------ |
| Register       | user_name, password    | AuthTokens               | INVALID_ARGUMENT, ALREADY_EXISTS           |
| Login          | user_name, password    | AuthTokens               | INVALID_ARGUMENT, UNAUTHENTICATED          |
| Refresh        | refresh_token          | AuthTokens               | UNAUTHENTICATED (просрочен/отозван/невалидная подпись) |
| RevokeToken    | refresh_token, access_token? | google.protobuf.Empty | UNAUTHENTICATED (подпись не прошла)  |
| ValidateToken  | access_token           | valid, UserContext       | — (невалидный токен → `valid=false`)       |
| GetUser        | user_id                | User                     | UNAUTHENTICATED, NOT_FOUND, PERMISSION_DENIED |

`AuthTokens`: access_token, refresh_token, access_token_expires_in,
refresh_token_expires_in (секунды).
`User`: user_id, user_name, role (enum Role: ADMIN/EMPLOYER/CUSTOMER), created_at.
`UserContext`: user_id, user_name, role.

Register создаёт пользователя с ролью CUSTOMER и сразу возвращает пару токенов
(авто-логин).
RevokeToken (logout): jti переданного refresh-token помечается revoked в БД;
если передан `access_token` — он проверяется **только по подписи** (exp не
проверяется — отозвать просроченный access тоже валидная операция), его jti
кладётся в Redis-denylist `auth:revoked:{jti}` с TTL = `exp − now`;
если оставшееся время ≤ 0 — denylist-запись пропускается (отзывать нечего,
успех). Все JwtVerifier'ы (во всех сервисах) проверяют denylist при
верификации access-token'а → отозванный access отклоняется везде.
Идемпотентен — уже отозванный токен → успех. Сам предъявленный токен
является credential'ом, проверки владельца нет.

**Denylist**: Redis, ключ `auth:revoked:{jti}` → `"1"`, TTL = до `exp` токена
(самоочищается). Записывает только auth-service; читают все JwtVerifier'ы.
Redis у auth и cart общий — разнесено префиксами ключей.

## 3. Модель данных и хранилище

PostgreSQL `auth_db`, Prisma (миграции через `prisma migrate`).

```prisma
model User {
  id            String         @id @default(uuid())
  userName      String         @unique @map("user_name")
  passwordHash  String         @map("password_hash")
  role          Role           @default(CUSTOMER)
  createdAt     DateTime       @default(now()) @map("created_at")
  refreshTokens RefreshToken[]
  @@map("users")
}
enum Role { ADMIN EMPLOYER CUSTOMER }
model RefreshToken {
  id        String    @id              // jti из refresh-JWT
  userId    String    @map("user_id")
  user      User      @relation(fields: [userId], references: [id])
  expiresAt DateTime  @map("expires_at")
  revokedAt DateTime? @map("revoked_at")
  createdAt DateTime  @default(now()) @map("created_at")
  @@map("refresh_tokens")
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

Seed: только `admin` (роль ADMIN). Креды берутся из env
(`SEED_ADMIN_USER_NAME`, `SEED_ADMIN_PASSWORD`), дефолт — `admin`/`admin`.

Доступ к БД — через repository-интерфейс поверх Prisma (нужен для моков
в unit-тестах).

## 4. События Kafka

| Направление | Топик              | eventType               | Payload                          |
| ----------- | ------------------ | ----------------------- | -------------------------------- |
| produce     | `auth.user.events` | `auth.user.registered`  | `{ userId, userName, role }`     |

**Transactional outbox**: `Register` пишет пользователя + запись в `outbox`
в одной транзакции. In-process `OutboxRelay` из `@book-shop/common`
публикует в Kafka и проставляет `published_at`; store-реализация сервиса
выбирает батчи через `SELECT … FOR UPDATE SKIP LOCKED`. Недоступный
брокер не ломает регистрацию — событие доедет позже (at-least-once).

## 5. Зависимости

Исходящих gRPC-зависимостей нет. Инфра: PostgreSQL, Kafka, Redis (denylist).

## 6. Аутентификация и авторизация

Defense in depth: сервис сам верифицирует JWT из metadata `authorization`
публичным ключом EdDSA + denylist (`JwtVerifier` из `@book-shop/common`).
Bearer-токен обязан иметь claim `typ="access"` — токены без `typ` или с
`typ="refresh"` отклоняются при верификации.

- Register/Login/Refresh/RevokeToken/ValidateToken — публичные (токен не нужен).
- GetUser — требует валидный JWT; свой профиль — любая роль, чужой — ADMIN
  или EMPLOYER (staff-доступ, консистентно с доступом к чужим заказам),
  иначе PERMISSION_DENIED.

## 7. Env-переменные

| Переменная               | Назначение                          | Пример                                  |
| ------------------------ | ----------------------------------- | --------------------------------------- |
| `GRPC_PORT`              | порт gRPC-сервера                   | `50051`                                 |
| `DATABASE_URL`           | строка подключения Prisma           | `postgresql://auth_user:auth_pass@localhost:5432/auth_db` |
| `KAFKA_BROKERS`          | brokers через запятую               | `localhost:29092`                       |
| `REDIS_URL`              | Redis (denylist `auth:revoked:*`)   | `redis://localhost:6379`                |
| `JWT_PRIVATE_KEY`        | PEM приватного ключа Ed25519, base64 | `<base64>`                             |
| `JWT_PUBLIC_KEY`         | PEM публичного ключа, base64        | `<base64>`                              |
| `JWT_ACCESS_TTL_SEC`     | TTL access-token                    | `28800`                                 |
| `JWT_REFRESH_TTL_SEC`    | TTL refresh-token                   | `2592000`                               |
| `REFRESH_TOKEN_AUDIT_TTL_SEC` | audit-retention удалённых GC refresh-строк (сек) | `604800` |
| `REFRESH_TOKEN_SWEEP_INTERVAL_SEC` | интервал GC-свипа (сек) | `3600`                    |
| `SEED_ADMIN_USER_NAME`   | логин seed-админа                   | `admin`                                 |
| `SEED_ADMIN_PASSWORD`    | пароль seed-админа                  | `admin`                                 |

Ключи — **через env** (PEM в base64) или через файл — `JWT_PRIVATE_KEY_FILE` /
`JWT_PUBLIC_KEY_FILE` (docker-secrets convention; файл имеет приоритет при
заданных обоих) — чтобы при деплое всё инжектилось сверху (secrets/CI).
Скрипт `gen-keys` (jose, Ed25519) печатает готовые base64-строки для `.env`;
публичный ключ читают также gateway и остальные сервисы (верификация).

## 8. Модель ошибок

- validation (`class-validator` по request): INVALID_ARGUMENT
- username занят: ALREADY_EXISTS
- неверный логин/пароль: UNAUTHENTICATED (без разделения «нет такого юзера»)
- refresh просрочен/отозван/невалидная подпись, JWT отсутствует/невалиден
  там, где требуется: UNAUTHENTICATED
- пользователь не найден: NOT_FOUND
- чужой профиль без роли ADMIN/EMPLOYER: PERMISSION_DENIED

## 9. Acceptance criteria

- Register: валидные данные → пользователь в БД (пароль — argon2-хэш, не plain),
  возвращены оба токена, в `outbox` появилась запись; после publish —
  `published_at` заполнено и событие доехало до `auth.user.events`
- Register при недоступном Kafka → успех; событие публикуется relay'ем после
  восстановления брокера
- Register с существующим user_name → ALREADY_EXISTS
- Login с верной парой → AuthTokens; неверный пароль/несуществующий user → UNAUTHENTICATED
- Access-token подписан EdDSA, payload: `sub=userId`, `user_name`, `role`,
  `jti` (uuid — нужен для denylist-отзыва), `typ="access"`. Refresh-token
  несёт те же claim'ы, но с `typ="refresh"`. Разделение типов строгое:
  `JwtVerifier` принимает только `typ="access"` (refresh не работает как
  bearer access и не покрывается denylist — поэтому тип обязателен),
  Refresh/RevokeToken — только `typ="refresh"`
- Refresh с валидным токеном → новая пара, старый jti помечен revoked;
  повторное использование старого → UNAUTHENTICATED (rotation)
- Refresh c отозванным/просроченным/невалидной подписью → UNAUTHENTICATED
- RevokeToken: валидный refresh → jti revoked в БД; переданный access → его
  jti в denylist → дальнейшая верификация этого access отклоняется и в
  auth, и в других сервисах; повторный RevokeToken → успех (идемпотентно);
  подделанный → UNAUTHENTICATED; просроченный, но валидно подписанный →
  UNAUTHENTICATED
- ValidateToken: валидный access → `valid=true` + UserContext; протухший
  или в denylist → `valid=false`
- GetUser: свой id → User; чужой id с ADMIN/EMPLOYER → User; чужой id с
  CUSTOMER → PERMISSION_DENIED; без JWT → UNAUTHENTICATED; несуществующий
  → NOT_FOUND
- Seed: при старте создаётся только admin из env-кредов
- Пароль нигде не возвращается и не логируется

## 10. Test plan

Изоляция: unit — persistence за repository-интерфейсом, мокается интерфейс
(не Prisma); e2e — каждый тест использует уникальный user_name, очистка БД
между тестами не требуется.

- Unit (`bun test`, `src/**/*.spec.ts`):
  argon2 hash/verify; jose EdDSA sign/verify (payload sub/user_name/role);
  истечение токенов — короткий TTL (`*_TTL_SEC=1`) + реальное ожидание по
  таймауту (время не мокаем); refresh-rotation (revoked jti); revoke —
  идемпотентность + denylist-запись access jti; GetUser ownership
  (свой/чужой/admin/employer/без токена);
  маппинг ошибок в gRPC codes
- e2e (`test/auth.e2e.spec.ts`, реальные postgres+kafka+redis из `infra/`):
  полный gRPC-сценарий register → login → validate → refresh → revoke →
  отозванный refresh и access (denylist) отклонены; seed-админ логинится;
  фактическая публикация `auth.user.registered` проверяется тестовым
  Kafka-consumer'ом; outbox: сервис поднят при `KAFKA_BROKERS=localhost:1`
  (producer подключается лениво/с ретраями — сервис обязан стартовать без
  брокера) → register успешен → брокер «поднялся» → relay опубликовал
  событие (или отдельный прогон relay'я)

## 11. NFR

- Runtime portability: код сервиса обязан запускаться под Node.js LTS и Bun
  без изменений — никаких `Bun.*`/`bun:*` вне тестов (правило AGENTS.md)
- Хэширование: argon2id (@node-rs/argon2), дефолтные параметры
- gRPC deadline на клиенте: 5s (задаёт вызывающая сторона)
- Refresh-rotation обязательна; старые токены не удаляются (аудит), revokedAt≠null
- Outbox: at-least-once доставка; потребители событий должны быть идемпотентны
- Пароль: min 8 символов, обязательно буква + цифра + спецсимвол;
  user_name: 3–32, `[a-zA-Z0-9_]`
