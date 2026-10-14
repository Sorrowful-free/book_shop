# 07. docker — контейнеризация полного стека

> Статус: approved
> Закрывает DEFERRED `O1` (docker-образы для сервисов включая web).
> Цель: `docker compose --profile apps up --build` поднимает работающий
> магазин без локально установленного bun/node.

## 1. Ответственность и границы

Делаем: Dockerfile'ы для 6 приложений, расширение `infra/docker-compose.yml`
профилем `apps`, проброс env по именам сервисов, миграции и сиды при старте,
healthcheck'и для зависимостей.

НЕ делаем: TLS/прод-ингресс, CI-интеграцию, multi-stage оптимизацию размера
образа сверх разумного, kubernetes-манифесты, hot-reload в контейнерах
(образы — для демо/деплоя, разработка остаётся локальной через bun).

## 2. Топология

```
browser ──► web:3001 (nitro, .output) ──BFF /api/*──► api-gateway:3000
                                                        │ gRPC plaintext
              ┌─────────────┬───────────────┬───────────┤
              ▼             ▼               ▼           ▼
        auth-service   catalog-service  cart-service  order-service
          :50051          :50052          :50053        :50054
              │               │               │           │
              ▼               ▼               ▼           ▼
           postgres:5432    postgres      redis:6379   postgres
           (auth_db)      (catalog_db)   + kafka:9092  (order_db)
```

Внутри сети compose `localhost` недоступен — вся адресация по именам
сервисов. `kafka:9092` уже advertised как `PLAINTEXT://kafka:9092` для
внутренних клиентов, менять не нужно; внешний `localhost:29092` остаётся
для локальной разработки.

## 3. Образы

### 3.1 `infra/docker/Dockerfile.service` — бэкенды (один файл, ARG)

Монорепо на bun workspaces: контекст сборки — корень репо, параметризация
через build-arg.

```dockerfile
# синопсис, не для копипасты в образ — реальный файл пишет имплементор
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile
# DB-сервисы: prisma client генерируется в src/generated/prisma
ARG PRISMA_SCHEMA=""          # "apps/auth-service/prisma/schema.prisma" и т.п.
RUN if [ -n "$PRISMA_SCHEMA" ]; then bunx prisma generate --schema "$PRISMA_SCHEMA"; fi
```

CMD через небольшой `infra/docker/entrypoint.sh`:
`[ -n "$PRISMA_SCHEMA" ] && bunx prisma migrate deploy --schema $PRISMA_SCHEMA`
→ `[ "$RUN_SEED" = "1" ] && bun run db:seed` (идемпотентный сид,
включён только у catalog-service — без книг AC2 не пройдёт; auth сидит
admin внутри приложения, у order сида нет)
→ `exec bun run src/main.ts`. Миграции идемпотентны; `prisma migrate dev`
в контейнерах НЕ используется — только `deploy` поверх `migrations/` в git.

Решения:
- один Dockerfile + `args: {APP: auth-service}` вместо 4-5 почти
  одинаковых файлов;
- базовый образ — `oven/bun:1` (**Debian**, не alpine): schema.prisma
  не объявляет `binaryTargets`, musl-engine пришлось бы добавлять, плюс
  риск с musl-сборкой `@node-rs/argon2`; размер образа спекой не
  оптимизируется;
- копируются **все** workspaces (`COPY apps ./apps`), а не только
  `apps/${APP}`: root package.json объявляет `apps/*`, и `bun install
  --frozen-lockfile` рискует упасть на отсутствующих пакетах; бонус —
  общие кешированные слои install для всех бэкенд-образов;
- рантайм — `oven/bun` (тулчейн репо); правило «no Bun runtime APIs»
  остаётся — код портабелен, образ можно пересобрать на node позже.

### 3.2 `infra/docker/Dockerfile.web` — двухстадийный

Stage 1 (`oven/bun`): install + `bunx --bun nuxt build` → `.output/`.
Stage 2 — **`node:22-alpine`** (зафиксировано): каноничная цель nitro
node-server preset и доказательство Node-портабельности.
`COPY --from=build /app/apps/web/.output .output`,
`CMD ["node", ".output/server/index.mjs"]`.

Внимание: в собранном `.output` `nuxt.config.ts` не исполняется —
runtimeConfig переопределяется env `NUXT_GATEWAY_URL` (не `GATEWAY_URL`),
порт — `PORT`/`NITRO_PORT` (не `NUXT_PORT` devServer). В compose для web
ставим `NUXT_GATEWAY_URL=http://api-gateway:3000` и `PORT=3001`.

### 3.3 .dockerignore (корень)

`node_modules`, `**/node_modules`, `**/.output`, `**/.nuxt`,
`**/src/generated`, `**/.env`, `.git`, `docs`, `infra`.

## 4. Compose: профиль `apps`

Существующий файл `infra/docker-compose.yml` остаётся единственным;
`infra:up` по-прежнему поднимает только инфру. Прикладные сервисы —
с `profiles: ["apps"]`:

```yaml
# синопсис
  auth-service:
    build: { context: .., dockerfile: infra/docker/Dockerfile.service,
             args: { APP: auth-service, PRISMA_SCHEMA: apps/auth-service/prisma/schema.prisma } }
    profiles: ["apps"]
    env_file: infra/docker/apps.env        # общие URL/адреса
    secrets: [jwt_private, jwt_public]
    environment:
      JWT_PRIVATE_KEY_FILE: /run/secrets/jwt_private
      JWT_PUBLIC_KEY_FILE: /run/secrets/jwt_public
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
      kafka:    { condition: service_healthy }
```

Аналогично catalog/order/cart/gateway/web. `kafka-init` и `kafka-ui`
остаются вне профиля (kafka-init должен завершиться до старта apps —
`depends_on: { condition: service_completed_successfully }`).

gRPC-порты сервисов **не публикуются** на хост — снаружи только
`gateway:3000` и `web:3001`; порты инфры (5432/6379/29092/8085) уже
проброшены существующими сервисами.

`env_file`/`secrets` пути относительны каталогу compose-файла:
`docker/apps.env`, `./secrets/jwt_*.pem` → `infra/docker/apps.env`,
`infra/secrets/`.

### Портинг env: localhost → имена сервисов

Новый файл `infra/docker/apps.env` (коммитится, секретов нет):

| Переменная | Локально | В compose |
| ---------- | -------- | --------- |
| `DATABASE_URL` (auth)  | `…@localhost:5432/auth_db`    | `…@postgres:5432/auth_db` |
| `DATABASE_URL` (catalog) | `…@localhost:5432/catalog_db` | `…@postgres:5432/catalog_db` |
| `DATABASE_URL` (order) | `…@localhost:5432/order_db`   | `…@postgres:5432/order_db` |
| `REDIS_URL`    | `redis://localhost:6379`  | `redis://redis:6379` |
| `KAFKA_BROKERS` | `localhost:29092`        | `kafka:9092` |
| `*_GRPC_ADDR`  | `localhost:5005X`        | `<service>:5005X` |
| `CORS_ORIGIN`  | `http://localhost:3001`  | `http://localhost:3001` (браузер!) |
| `GATEWAY_URL`  | `http://localhost:3000`  | `http://api-gateway:3000` |
| `COOKIE_SECURE` | `false`                 | `false` |

`dotenv/config` не перекрывает env процесса — compose `environment`/`env_file`
побеждает локальные `.env` без правок кода. Важно: `.env` файлы НЕ копируются
в образ (см. .dockerignore), иначе localhost-адреса просочатся внутрь.

`CORS_ORIGIN` — origin браузера, поэтому остаётся `localhost:3001`;
`GATEWAY_URL` — серверный вызов BFF→gateway, поэтому внутреннее имя.

## 5. JWT-ключи

`*_FILE`-конвенция (`resolveSecret` в `@book-shop/common`) уже поддерживает
docker-secrets — кода не трогаем:

```bash
# разово, хост — одной командой (скрипт из этого плана):
bun run infra:secrets
# = apps/auth-service `bun run gen-keys` → base64-PEM значения пишутся
# в infra/secrets/{jwt_private.pem,jwt_public.pem} (gitignored)
```

```yaml
secrets:
  jwt_private: { file: ./secrets/jwt_private.pem }
  jwt_public:  { file: ./secrets/jwt_public.pem }
```

`jwt_private` монтируется только в auth-service; `jwt_public` — во все
JWT-верифицирующие (auth, catalog, cart, order, gateway). Документировать
в `infra/README.md` или README compose-секции; добавить
`infra/secrets/` в `.gitignore`.

## 6. Healthcheck'и и порядок старта

gRPC-стек HTTP-ручки не имеет — healthcheck через TCP-пробу рантаймом
образа (bun/node есть в каждом):

```yaml
healthcheck:
  test: ["CMD-SHELL", "bun -e 'require(\"net\").connect(+(process.env.GRPC_PORT||50051),\"0.0.0.0\").on(\"connect\",()=>process.exit(0)).on(\"error\",()=>process.exit(1))'"]
  interval: 5s
  retries: 12
```

- gateway: `GET http://localhost:3000/api/v1/books` → 200/любой ответ
  сервера (fetch в образе есть).
- web: `GET http://localhost:3001/` → 200.
- web зависит от gateway (healthy), gateway — от всех четырёх gRPC
  (healthy), те — от postgres/redis/kafka.
- Точность не критична: сервисы сами ретраят подключения (Kafka/outbox
  relay уже переживает рестарт брокера — покрыто e2e).

## 7. Env-переменные (свод)

Источник истины — `apps/*/.env.example`; compose-файл поставляет:
общие адреса через `infra/docker/apps.env`, секреты через `secrets:`,
плюс per-service `environment:` (порты, TTL при желании, `SEED_*`).

`SEED_ADMIN_*` по умолчанию включён (демо-стек). `SEED_EMPLOYER_*` —
опционально через `.env`/override.

Root-алиасы по аналогии с `infra:*`: `apps:up`
(`docker compose -f infra/docker-compose.yml --profile apps up -d --build`),
`apps:down`, `apps:logs`.

## 8. Acceptance criteria

1. `docker compose -f infra/docker-compose.yml --profile apps up -d --build`
   на чистом clone (только `infra/secrets/` предсозданы) → все контейнеры
   healthy, `web` отвечает на `:3001`.
2. Регистрация нового юзера через UI → добавление в корзину → checkout →
   pay → заказ в `/orders` в статусе PAID.
3. `admin/admin` → `/admin/books` CRUD доступен; заказ юзера виден в
   БД и событие `order.order.created` в kafka-ui (`:8085`).
4. `docker compose ... down && up` — данные переживают рестарт (volumes),
   миграции идемпотентны, сиды не дублируются.
5. `infra:up` без профиля по-прежнему поднимает только инфру — локальная
   разработка не сломана.
6. `bun test`, `bun run lint`, `bun run typecheck` на хосте — без
   регрессий (docker-файлы не трогают код).

## 9. Test plan

- Автотесты не требуются (инфраструктурная задача); проверка — ручной
  прогон acceptance criteria.
- Опционально: `apps/web/test/bff-smoke.mjs`-подобный скрипт против
  поднятого compose-стека вместо stub — НЕ входит в объём.

## 10. Документация при сдаче

- `apps/README.md` или корневой README: секция «Run with Docker».
- `docs/DEFERRED.md`: пункт O1 удалить/пометить resolved со ссылкой на
  этот документ.
- `infra/README.md` (создать, если нет): команды gen-keys → secrets →
  compose up.

## 11. NFR / риски

- Build context = весь репо; `.dockerignore` обязателен (node_modules и
  .output иначе удут туда-сюда и ломают layer cache).
- `oven/bun`-образы тянут ~100-200MB; web node-образ — только `.output`
  (~deсятки MB).
- Первый `up` после смены схемы БД на старом volume может требовать
  `docker compose down -v` — задокументировать.
- dev-mode (`nuxt dev`, `bun --watch`) в контейнерах не нужен — образы
  для запуска, не для разработки.
