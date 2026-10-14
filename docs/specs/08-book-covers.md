# 08. book-covers — обложки книг (MinIO + presigned upload)

> Статус: implemented
> Proto: `packages/contracts/proto/catalog.proto` (расширение)
> Затрагивает: `packages/contracts`, `apps/catalog-service`,
> `apps/api-gateway`, `apps/web`, `infra/docker-compose.yml`,
> `apps/catalog-service/prisma/seed.ts`

## 1. Ответственность и границы

`Book.cover_url` уже существует сквозь весь стек (proto → Prisma → gateway →
web): карточка и страница книги умеют рендерить обложку и плейсхолдер.
Спека наполняет его содержимым двумя путями:

1. **Сид** — витринные обложки по ISBN через Open Library (внешние URL,
   ничего не храним). Сид расширяется до ~24–30 книг.
2. **Upload админом** — presigned **POST policy**: браузер грузит файл
   напрямую в MinIO (S3), `cover_url` книги получает относительный путь,
   чтение идёт через gateway-прокси (bucket приватный).

Делает: хранение/раздачу загруженных обложек (catalog-service — владелец),
upload-UX в `BookFormModal`, сид с реальными обложками, фолбэк-плейсхолдер.

НЕ делает: ресайз/конвертацию изображений, CDN, удаление объектов при
смене/удалении обложки книги (orphan-объекты — см. §11), presigned GET,
публичный bucket, загрузку обложек не-Staff пользователями.

## 2. Хранилище и семантика `cover_url`

- **MinIO** (`book-covers` bucket, **приватный**) — объектное хранилище для
  загруженных обложек. Новый сервис в `infra/docker-compose.yml`
  (infra-профиль, не `apps` — e2e и dev используют его через `infra:up`).
- **Ключ объекта**: `<uuid>.<ext>` (плоско, без префиксов-папок; ext из
  content-type: `jpg|png|webp`).
- **`cover_url`** хранит *готовый для браузера* путь/URL:
  - загруженная обложка → `/api/v1/covers/<key>` (относительный путь
    gateway; через web-BFF тот же путь проходит — см. §6);
  - сид/внешние обложки → абсолютный `https://…` URL (как сейчас).
- Семантика `Book.cover_url` не меняется: opaque-строка, `optional`.
  Рендерится как `<img src>` как есть.

### MinIO в compose

```yaml
minio:
  image: minio/minio:RELEASE.<pinned>        # пин конкретного релиза
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: minioadmin              # dev-only, как postgres/postgres
    MINIO_ROOT_PASSWORD: minioadmin
  ports:
    - "9000:9000"   # S3 API — нужен БРАУЗЕРУ для presigned POST
    - "9001:9001"   # консоль (dev-удобство)
  volumes: [minio-data]
  healthcheck: curl -fsS http://localhost:9000/minio/health/live

minio-init:                                   # one-shot, как kafka-init
  image: minio/mc:<pinned>
  command: mb --ignore-existing minio/book-covers  # приватный по умолчанию
  depends_on: minio: service_healthy
```

- catalog-service (apps-профиль): `depends_on: minio healthy +
  minio-init completed_successfully`.
- api-gateway НЕ получает прямого доступа к MinIO — читает обложки только
  через catalog gRPC (ownership).
- В `infra/README.md` — раздел про MinIO (консоль :9001, dev-креды).

## 3. gRPC-контракт (`catalog.proto`, `bookshop.catalog.v1`)

```proto
service CatalogService {
  // ... существующие RPC без изменений ...

  // EMPLOYER or ADMIN — presigned POST policy для прямого upload'а
  // браузером в S3. Возвращает url + form-fields + будущий cover_url.
  rpc CreateCoverUpload(CreateCoverUploadRequest)
      returns (CreateCoverUploadResponse);

  // Public — отдаёт хранимую обложку (gateway проксирует браузеру).
  rpc GetBookCover(GetBookCoverRequest) returns (GetBookCoverResponse);
}

message CreateCoverUploadRequest {
  // image/jpeg | image/png | image/webp — иначе INVALID_ARGUMENT.
  string content_type = 1;
}

message CreateCoverUploadResponse {
  // Browser-reachable endpoint MinIO (S3_PUBLIC_ENDPOINT).
  string upload_url = 1;
  // POST-policy form fields (key, policy, signature, Content-Type…):
  // клиент отправляет multipart/form-data: fields + file.
  map<string, string> fields = 2;
  // Значение для Book.cover_url: "/api/v1/covers/<key>".
  string cover_url = 3;
}

message GetBookCoverRequest {
  string key = 1; // "^[0-9a-f-]{36}\.(jpe?g|png|webp)$" — иначе INVALID_ARGUMENT
}

message GetBookCoverResponse {
  bytes data = 1;
  string content_type = 2;
}
```

- `Book.cover_url`, `CreateBookRequest.cover_url`, `UpdateBookRequest.cover_url`
  — без изменений (opaque string).
- Генерация: `bun run proto:gen`; изменения contracts лендятся **до** кода.

## 4. catalog-service

### CoverStorage (port)

Новый модуль `src/covers/` по образцу существующих инъекций (`KafkaLike` в
`@book-shop/common` — структурный интерфейс + lazy init + тестовые дубли):

```ts
interface CoverStorage {
  presignedPostPolicy(key: string, contentType: string,
    maxBytes: number, ttlSec: number): Promise<{ url: string; fields: Record<string, string> }>;
  getObject(key: string): Promise<{ data: Buffer; contentType: string }>;
}
```

- Реализация — npm-пакет **`minio`** (pure-JS, portable Node/Bun;
  `presignedPostPolicy` + `getObject` из коробки). Альтернатива —
  `@aws-sdk/client-s3` + `@aws-sdk/s3-presigned-post`, если имплементор
  предпочтёт AWS SDK; интерфейс-зависимость остаётся `CoverStorage`.
- **Два клиента** (иначе presign ломается):
  - *ops-клиент* — `S3_ENDPOINT` (внутренний: `http://minio:9000` в compose,
    `http://localhost:9000` в dev) для `getObject`;
  - *signing-клиент* — `S3_PUBLIC_ENDPOINT` (`http://localhost:9000` — адрес,
    доступный браузеру) для `presignedPostPolicy`: подпись вычисляется над
    host'ом endpoint'а, поэтому presign обязан идти публичным адресом.
- POST-**policy** (не PUT): условия `eq content-type` (whitelist) +
  `content-length-range 1..COVER_UPLOAD_MAX_BYTES` + `eq key` — MinIO
  отвергает нарушения на стороне хранилища.
- `contentType` объекта при `getObject` берётся из `statObject`/metaData —
  сохраняем исходный mime при upload (policy `eq Content-Type`).

### RPC-поведение

| RPC | Auth | Поведение | Ошибки |
| --- | ---- | --------- | ------ |
| `CreateCoverUpload` | EMPLOYER\|ADMIN (как `CreateBook`) | генерирует `<uuid>.<ext>`, строит post-policy, возвращает `{upload_url, fields, cover_url}` | `INVALID_ARGUMENT` mime вне whitelist; `UNAUTHENTICATED`/`PERMISSION_DENIED` по матрице; `UNAVAILABLE` при недоступном MinIO |
| `GetBookCover` | public (как `GetBook`) | валидирует формат key, `getObject` → bytes + mime | `INVALID_ARGUMENT` формат key; `NOT_FOUND` объекта нет; `UNAVAILABLE` MinIO down |

- Boundary DTO + `requestValidationPipe` (`@book-shop/common`) — как у
  соседних методов; `@Ctx() metadata?: Metadata` обязателен (AGENTS.md).
- `CreateCoverUpload` НЕ привязан к книге и НЕ пишет в БД: book создаётся/
  обновляется отдельным `CreateBook`/`UpdateBook` с полученным `cover_url`
  (двухшаговый UX — как у большинства presigned-flow).
- Событий Kafka нет: `cover_url` едет в существующих `book.created`/
  `book.updated` внутри `Book`-payload.

## 5. api-gateway

Новый `covers.controller.ts` (`@Controller("covers")` → `/api/v1/covers`):

| Route | Auth | Поведение |
| ----- | ---- | --------- |
| `POST /covers/upload` | `AuthGuard`+`RolesGuard` EMPLOYER\|ADMIN | body `{contentType}` (DTO+ValidationPipe) → `catalog.createCoverUpload` → `{uploadUrl, fields, coverUrl}` |
| `GET /covers/:key` | public (без гардов — `<img>` без auth) | `catalog.getBookCover({key})` → байты клиенту: `Content-Type` из ответа, `Content-Length`, `Cache-Control: public, max-age=31536000, immutable` (ключи — uuid, контент иммутабелен). `NOT_FOUND`→404, `INVALID_ARGUMENT`→400 через существующий error-mapping |

- Валидация `:key` тем же regex, что в §3 (defense in depth; не даём
  пробрасывать произвольные ключи в хранилище).
- gRPC-ответ (`bytes`) — unary, обложки мелкие; стриминг по HTTP через
  `StreamableFile`/raw body — на выбор имплементора.
- Swagger: оба эндпоинта в `@ApiTags("covers")`.

## 6. web (`apps/web`)

### 6.1 BFF-фикс `mapProxyPath`

Сейчас `/api/v1/covers/x` через BFF превращается в `/api/v1/v1/covers/x`
(strip `/api/` → prepend `v1/`). Фикс: путь, уже начинающийся с
`/api/v1/`, проксируется без повторного префикса (`/api/v1/*` →
`/api/v1/*` как есть). Юнит-тест в `server/utils/proxy.spec.ts`.

> Это делает `cover_url="/api/v1/covers/<key>"` каноничным для обоих
> потребителей: web (same-origin → BFF → gateway) и прямых клиентов
> gateway (`:3000/api/v1/covers/<key>`).

### 6.2 `BookFormModal` — upload-виджет

- Рядом с текстовым полем `Cover URL` — file input
  (`accept="image/jpeg,image/png,image/webp"`) + превью.
- Flow на выбор файла:
  1. клиентская проверка mime + размера (≤ 2 МБ) — ошибка в форму без
     запроса;
  2. `POST /api/covers/upload {contentType}` → `{uploadUrl, fields, coverUrl}`;
  3. `fetch(uploadUrl, {method:"POST", body: FormData(fields…, file)})`
     напрямую в MinIO;
  4. успех → `form.coverUrl = coverUrl`, превью через `URL.createObjectURL`
     (мгновенно, без прохода через прокси);
  5. ошибка любого шага → сообщение в форме, `coverUrl` не трогаем.
- Текстовое поле `Cover URL` остаётся: ручной URL (внешние обложки)
  приоритетнее, если заполнен после upload'а — upload перезаписывает поле.
- Состояния: `uploading` (spinner/disable submit), превью текущей обложки
  при edit.

### 6.3 Фолбэк обложки

`<img>` в `BookCard` и `books/[id]` получает `@error`-хендлер: битый URL
(Open Library 404/сеть) → показываем существующий плейсхолдер-блок
(заменяет `v-if="book.coverUrl"` на `v-if="coverOk"` локальным состоянием).
Тот же хендлер в `BookFormModal`-превью.

## 7. Сид (`apps/catalog-service/prisma/seed.ts`)

- Расширение до **~24–30 книг**: все жанры (fantasy, sci-fi, tech,
  dystopia, non-fiction + минимум mystery/history), реальные ISBN,
  разброс `price`/`stock`/`year`.
- `coverUrl` каждой книге:
  `https://covers.openlibrary.org/b/isbn/<isbn>-L.jpg?default=false`
  (`?default=false` → OL отдаёт 404 вместо пустышки 1×1 — наш `@error`
  покажет плейсхолдер). Имплементор проверяет curl'ом, что выбранные ISBN
  имеют реальные обложки (≥ ~10 КБ); промахи → другой ISBN/издание.
- **Идемпотентность**: upsert по `isbn` как сейчас; `coverUrl` проставляется
  на create и добивается на существующих строках только если `cover_url IS
  NULL` (не затираем загруженные админом обложки при повторном сиде —
  `updateMany … where coverUrl: null` либо эквивалент).

## 8. Env-переменные (catalog-service)

| Переменная | Назначение | Пример |
| ---------- | ---------- | ------ |
| `S3_ENDPOINT` | внутренний endpoint MinIO (ops) | `http://localhost:9000` |
| `S3_PUBLIC_ENDPOINT` | endpoint для presign (browser-reachable) | `http://localhost:9000` |
| `S3_BUCKET` | bucket обложек | `book-covers` |
| `S3_REGION` | регион (формальный для MinIO) | `us-east-1` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | креды MinIO (`*_FILE` тоже) | `minioadmin` |
| `COVER_UPLOAD_MAX_BYTES` | лимит POST-policy | `2097152` (2 МБ) |
| `COVER_UPLOAD_TTL_SEC` | TTL presigned policy | `600` |

- Креды через `resolveSecret` (`S3_ACCESS_KEY_FILE` и т.п.) — конвенция
  репо. `.env.example` пополняется.
- Compose apps-профиль: `S3_ENDPOINT=http://minio:9000`,
  `S3_PUBLIC_ENDPOINT=http://localhost:9000` (браузер ходит на
  хост-порт), остальное — в `docker/apps.env`.

## 9. Модель ошибок

| Ситуация | gRPC | HTTP |
| -------- | ---- | ---- |
| mime вне whitelist | `INVALID_ARGUMENT` | 400 |
| key не по формату | `INVALID_ARGUMENT` | 400 |
| объект не найден | `NOT_FOUND` | 404 |
| MinIO недоступен | `UNAVAILABLE` | 503 |
| upload без Staff-роли | `PERMISSION_DENIED` | 403 |
| presigned POST нарушил policy (размер/mime) | — | 403 от MinIO (сырой, показываем generic-ошибку в форме) |

## 10. Acceptance criteria

- `bun run infra:up` поднимает minio + minio-init (bucket создан,
  приватный); `docker compose ps` — healthy.
- Staff-юзер: `POST /api/covers/upload {contentType:"image/png"}` → 200 с
  `uploadUrl`, `fields`, `coverUrl` вида `/api/v1/covers/<uuid>.png`.
- Тот же запрос от USER-роли → 403; без сессии → 401.
- Upload файла по presigned POST (multipart, поля+file) → 200/204 от
  MinIO; `GET /api/v1/covers/<key>` → байты с исходным `Content-Type` и
  `Cache-Control: immutable`.
- Presigned POST с mime вне whitelist или >2 МБ → отказ MinIO (policy).
- `GET /api/v1/covers/<несуществующий>` → 404; key с `../`/мусором → 400.
- Админ создаёт книгу с загруженной обложкой через `BookFormModal` →
  обложка видна на витрине и на странице книги (и в Docker-стеке, и локально).
- Сид: `bun run db:seed` → ≥24 книги, у всех `cover_url` на OL; витрина
  показывает реальные обложки; повторный сид не затирает ручные `cover_url`.
- Битый `cover_url` → плейсхолдер вместо сломанного `<img>`.

## 11. Test plan

**Unit:**
- catalog `covers`: presign-ответ согласован (fields.key = cover_url's key;
  policy ограничения присутствуют); whitelist mime → `INVALID_ARGUMENT`;
  key-regex → `INVALID_ARGUMENT`; `getObject` пробрасывает bytes+mime;
  S3-ошибка NoSuchKey → `NOT_FOUND`, прочее → `UNAVAILABLE`. Fake
  `CoverStorage` по образцу `KafkaLike`-дублей.
- gateway covers-controller: матрица ролей, маппинг ошибок, заголовки
  `Cache-Control`/`Content-Type` на ответе.
- web: `mapProxyPath` — `/api/v1/*` без двойного префикса; `BookFormModal`
  upload-flow с подменённым `$fetch`/`fetch` (успех, reject на шаге 2 и 3).

**e2e** (реальный MinIO из compose):
- catalog: `CreateCoverUpload` → реальный HTTP POST в MinIO →
  `GetBookCover` roundtrip (байты совпадают, mime сохранён); oversized
  payload → MinIO 403.
- gateway: полный REST-сценарий upload→get + роли.
- Пометить зависимость `test:e2e` от minio (README/AGENTS при необходимости).

## 12. NFR / риски / отложено

- Runtime portability: `minio`-клиент — pure JS, `Bun.*` не нужен.
- Идемпотентность: presign идемпотентен (новый uuid каждый раз — ок,
  повтор = новый объект); `GetBookCover` read-only.
- **Orphan-объекты**: файл загружен, но книга не сохранена / обложка
  заменена / книга удалена → объект остаётся в bucket. Осознанно отложено:
  кандидат на запись в `docs/DEFERRED.md` (sweeper «объекты старше X без
  ссылок в books.cover_url»).
- Размер лимит 2 МБ — компромисс для демо; валидация content-type только
  по объявленному mime (sniffing — отложено, учебный проект).
- Обложки — публичные данные; приватность bucket'а нужна только чтобы
  раздача шла контролируемо через gateway (кэш-заголовки, единая точка).
- Copyright: сид ссылается на чужие обложки по URL (не хостим) —
  для учебного проекта приемлемо; в репо бинарные обложки не коммитим.
