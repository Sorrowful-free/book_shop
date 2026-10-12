# 06. web (Nuxt SSR)

> Статус: approved
> Порт: `:3001` | Хранилище: — | Клиент api-gateway через Nuxt server routes

## 1. Ответственность и границы

SSR-фронтенд магазина на Nuxt (Vue 3). Витрина каталога, корзина (в т.ч.
гостевая), checkout + эмуляция оплаты, история заказов, auth-страницы,
админ-раздел управления книгами.

Делает: рендеринг страниц (SSR), BFF-прокси к gateway через server routes
с пробросом httpOnly-cookies, клиентскую интерактивность.
НЕ делает: бизнес-логику, хранение, работу с токенами в JS (cookies httpOnly).

## 2. Страницы

| Route            | Контент                                                       | Доступ             |
| ---------------- | ------------------------------------------------------------- | ------------------ |
| `/`              | каталог: карточки книг, поиск, фильтр genre, пагинация         | public             |
| `/books/[id]`    | карточка книги: данные, цена, наличие, добавить в корзину      | public             |
| `/cart`          | корзина: позиции (обогащённые), кол-во, сумма, к checkout      | public (guest ok)  |
| `/checkout`      | подтверждение заказа → «оплатить» (эмуляция)                   | auth               |
| `/orders`        | мои заказы: статус, состав, cancel/pay                          | auth               |
| `/login`         | форма входа                                                    | public             |
| `/register`      | форма регистрации                                              | public             |
| `/admin/books`   | список + create/update/delete/restore                          | Employer, Admin    |

Route middleware: `/checkout`, `/orders*` — редирект на /login без сессии;
`/admin/*` — редирект не-Employer/Admin на /. Текущий пользователь — через
`GET /api/auth/me` (SSR), кэшируется в useState на запрос.
В `/admin/books` кнопки delete/restore отображаются только для Admin
(роль EMPLOYER их скрывает — иначе dead-403, матрица см. спеку 05).

## 3. BFF (server routes)

`server/api/**` — catch-all прокси на `GATEWAY_URL/api/v1/**` (клиентские
пути `/api/*` → gateway `/api/v1/*`):

- запрос: проксирование метода/тела + `cookie`-заголовок клиента
- ответ: проксирование статуса/тела + проброс `set-cookie` клиенту
- клиентский код и SSR ходят только на same-origin `/api/*` — gateway снаружи
  не светится

## 4. Состояние и поведение

- Auth: useState `user` + `useFetch('/api/auth/me')`; login/register/logout —
  формы на server routes; после login гостевая корзина сливается (делает
  gateway через `cart_id`-cookie)
- Cart: счётчик позиций в header; после операций — refresh через /api/cart
- Обогащение позиций корзины делает gateway (BFF-агрегация) — web получает
  готовые name/price/available
- Книги с `is_deleted` показываются на витрине с пометкой «недоступна»,
  кнопка «в корзину» отключена; stock=0 — аналогично

## 5. Стилизация

Tailwind CSS (`@nuxtjs/tailwindcss`). Минимальный чистый UI: header с
логотипом/поиском/корзиной/профилем, карточная сетка, таблицы в admin.

## 6. Env-переменные

| Переменная         | Назначение                    | Пример                 |
| ------------------ | ----------------------------- | ---------------------- |
| `GATEWAY_URL`      | base URL api-gateway (server) | `http://localhost:3000`|
| `PORT` / NUXT_PORT | порт dev/prod сервера         | `3001`                 |

Секретов нет — JWT только в httpOnly-cookies, web их не читает.

## 7. Acceptance criteria

- `/` рендерится SSR с книгами из gateway; поиск/genre/пагинация работают
- Гость: добавление в корзину создаёт cart_id-cookie; корзина открывается и
  показывает позиции с ценами
- login → user в useState, гостевая корзина сливается; logout → сессия снята
- `/checkout` создаёт заказ и ведёт на оплату (PayOrder) → статус PAID на /orders
- Неавторизованный на /checkout или /orders → редирект на /login
- Employer/Admin видят /admin/books и могут CRUD + restore; Customer — редирект
- SSR без JS: каталог и карточки рендерятся полностью (навигация — клиентская)

## 8. Test plan

- Unit (`bun test` где применимо): чистые хелперы (форматирование цены,
  маппинг API→view-model, guards-логика middleware)
- e2e: ручная/сквозная проверка в Plan 7 (полный стек); опционально playwright
  как отдельная задача — вне обязательного объёма

## 9. NFR

- SSR обязателен для публичных страниц (SEO/показательность)
- Все API-вызовы только same-origin через server routes; gateway-адрес —
  server-only env (не в runtimeConfig.public)
- Runtime portability кода не касается (Nuxt живёт под node/nitro), но без
  Bun-specific API
