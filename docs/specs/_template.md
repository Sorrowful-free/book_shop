# NN. <service-name>

> Статус: draft | approved | implemented
> Proto: `packages/contracts/proto/<service>.proto`
> Порт: `:5005X` | Хранилище: <postgres db | redis | —>

## 1. Ответственность и границы

Что сервис делает, чего НЕ делает, какие доменные сущности владеет.

## 2. gRPC-контракт

Список RPC со ссылкой на proto-файл. Таблица: RPC → request → response → коды ошибок.
Контракт мёржится в `packages/contracts` до реализации.

## 3. Модель данных и хранилище

Схема таблиц/ключей, миграции, индексы. Database-per-service: чужие базы не трогаем.

## 4. События Kafka

| Направление | Топик | eventType | Payload |
| ----------- | ----- | --------- | ------- |

Топики и типы из `packages/contracts/src/{topics,events}.ts`. Новые события —
только через расширение contracts.

## 5. Зависимости

gRPC-клиенты к другим сервисам: какие RPC вызываем, зачем, поведение при недоступности.

## 6. Аутентификация и авторизация

Какие RPC требуют валидный JWT (metadata `authorization`, верификация в самом
сервисе через `JwtVerifier` из `@book-shop/common` — EdDSA public key +
Redis-denylist `auth:revoked:{jti}`), какие роли/ownership-правила применяются.
Gateway — первый рубеж (roles-матрица), но не единственный.

## 7. Env-переменные

| Переменная | Назначение | Пример |
| ---------- | ---------- | ------ |

## 8. Модель ошибок

Маппинг доменных ошибок на gRPC status codes (NOT_FOUND, INVALID_ARGUMENT, ...).

## 9. Acceptance criteria

Проверяемый список (given/when/then), покрывающий контракт.

## 10. Test plan

- Unit: какие сущности/сервисы, что мокаем
- e2e: сценарии через gRPC-клиента с поднятыми зависимостями из compose

Тесты пишутся до реализации и должны падать.

## 11. NFR

Timeouts, retries, идемпотентность, лимиты.
Обязательно: runtime portability — код работает под Node.js LTS и Bun
(без `Bun.*`/`bun:*` вне тестов, см. AGENTS.md).
