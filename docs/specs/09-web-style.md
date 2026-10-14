# 09. web-style — визуальный рефреш витрины

> Статус: draft
> Затрагивает: `apps/web` (только стили/шаблоны; без изменений
> backend, контрактов и логики)

## 1. Ответственность и границы

Довести UI до цельного «современный e-commerce» вида: нейтральная база +
один акцент (indigo-600 остаётся), строгая сетка, больше воздуха,
консистентные контролы. Дизайн-токены — в собственном
`tailwind.config.ts`, повторяющиеся паттерны — в component-классах.

Делает: дизайн-токены, рестайл всех страниц и компонентов, общий
компонент обложки с плейсхолдером, состояния (hover/focus/disabled/empty).

НЕ делает: тёмную тему, component library (Nuxt UI/shadcn), функциональные
изменения (фильтры, логика корзины и т.п. — как есть), анимации сложнее
transition-классов, рестайл Swagger/сервисных страниц вне `apps/web`.
Баг счётчика корзины — отдельная fix-спека `fixes/web.md` (F-W1), сюда
не входит.

## 2. Дизайн-токены (`apps/web/tailwind.config.ts`)

Файл создаётся (сейчас его нет — дефолт `@nuxtjs/tailwindcss`).

| Токен | Решение |
| ----- | ------- |
| Нейтралы | `zinc` (тёплый нейтрал; фон страницы `zinc-50`, поверхности `white`, границы `zinc-200`, текст `zinc-900`/`zinc-500`) |
| Акцент | `primary` = палитра `indigo` (как сейчас; кнопки `indigo-600`, hover `indigo-700`, фокус-кольцо `indigo-500`) |
| Семантика | `success`/`warning`/`danger` — emerald/amber/red для статусов заказов и stock-бейджей |
| Шрифт | `@fontsource-variable/inter` (self-hosted, без CDN — работает офлайн и в Docker); fallback system stack |
| Радиусы | карточки `rounded-xl`, контролы `rounded-lg` |
| Тени | `shadow-card`: мягкая карточная тень; `shadow-card-hover` — приподнятая |
| Обложка | `aspect-[2/3]` (книжная пропорция) вместо фиксированных высот |

Токены семантические (`bg-surface`, `text-muted`, `bg-primary` и т.п.) —
чтобы смена палитры позже (включая dark) была точечной.

## 3. Component-классы (`app/assets/css/main.css`)

`@layer components` с `@apply` для повторяющихся паттернов — убирает
utility-soup из шаблонов и гарантирует консистентность:

- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost` —
  одинаковая геометрия (h-9, px-4, rounded-lg, font-medium), состояния
  hover/active/disabled/focus-visible;
- `.input` — единый стиль всех полей (border-zinc-300, focus ring primary);
- `.card` — `rounded-xl border border-zinc-200 bg-white shadow-card`;
- `.badge` — чипы статусов/жанра/stock;
- `.page` — `mx-auto max-w-7xl px-4 sm:px-6` (единый контейнер; header
  и контент выравниваются по одной сетке).

## 4. Рестайл по элементам

### 4.1 Компоненты

- **`AppHeader`**: sticky + `backdrop-blur` на `bg-white/80` с нижней
  границей; поиск — широкий `.input` в центре; навигация — ghost-ссылки с
  active-состоянием; бейдж корзины — pill `bg-primary`; кнопки
  login/logout — `.btn-secondary`/`.btn-primary`.
- **`BookCard`**: cover `aspect-[2/3] w-full object-cover` + hover-lift
  (`transition` на тень/translate); заголовок `line-clamp-2`, автор muted,
  жанр `.badge`; цена `font-semibold`; «Only N left» — amber-badge;
  кнопка `.btn-primary` full-width; `isDeleted` — карточка приглушена +
  `.badge` «Unavailable».
- **`PaginationBar`**: кнопки `.btn-secondary`, текущая страница — акцент;
  компактные chevron-стрелки (unicode/svg-иконка, без emoji-стиля).
- **`BookFormModal`**: `rounded-2xl shadow-xl`, отступы `p-6`, заголовок
  `text-lg font-semibold`, поля `.input` в сетке, превью обложки
  `aspect-[2/3] w-24`, кнопки по §3 (из 08 приезжает upload-виджет —
  стилизуется теми же классами).
- **Новый `BookCover`** (общий): `<img>` + `@error`-фолбэк + плейсхолдер —
  нейтральный градиент (`zinc-100→zinc-200`) с инициалами названия/автора,
  `aspect-[2/3]`. Используется в `BookCard`, `books/[id]`, `cart`,
  превью формы. (08 даёт `@error`-механику; если 09 идёт раньше —
  плейсхолдер появляется здесь и 08 только унифицирует.)

### 4.2 Страницы

| Страница | Рестайл |
| -------- | ------- |
| `/` | toolbar-панель (search + genre + кнопки) в одной `.card`-полосе или flex-ряде; сетка `grid-cols-2 sm:3 lg:4` с `gap-5`; empty/error-состояния — `.card` с muted-текстом; заголовок + счётчик найденного |
| `/books/[id]` | двухколоночный layout: обложка `aspect-[2/3] max-w-sm` слева (карточка с тенью), детали справа — название `text-3xl`, автор, жанр-чип, цена крупно, наличие, `.btn-primary`; «назад в каталог»-ссылка |
| `/cart` | строки позиций — `.card` с мини-обложкой (`w-14 aspect-[2/3]`), qty `.input` `w-16`; summary-блок справа/снизу (итог + `.btn-primary` Checkout); empty-state с CTA «в каталог» |
| `/checkout` | summary-карточка заказа, крупная `.btn-primary` «Pay …», ошибки — alert-класс |
| `/orders` | заказы — `.card`-список; статус — `.badge` (CREATED amber, PAID emerald, CANCELLED zinc); кнопки действий справа |
| `/login`, `/register` | центрированная `.card max-w-sm` на `bg-zinc-50`, `.input`, `.btn-primary w-full`, ссылка-переход между формами muted |
| `/admin/books` | таблица: `thead` uppercase-xs muted, строки `hover:bg-zinc-50`, разделители `divide-y`; действия — ghost-кнопки; пагинация как на витрине |

### 4.3 Состояния

- `focus-visible` ring на всех интерактивах (a11y), `:disabled` — 50%
  opacity + `cursor-not-allowed`;
- hover-переходы `transition-shadow/colors` 150–200ms;
- loading-скелет витрины оставляем `opacity-50` (уже есть) — при желании
  лёгкий `animate-pulse`.

## 5. Зависимости

- `bun add @fontsource-variable/inter` (или обычный `@fontsource/inter`
  с 2–3 весами) — единственная новая зависимость; импорт в `main.css`/
  plugin + `fontFamily.sans` в конфиге.
- Никаких UI-библиотек, иконки — простые unicode/inline-SVG при
  необходимости (без иконочных пакетов).

## 6. Acceptance criteria

- `tailwind.config.ts` создан; токены (`primary`, `surface`, `muted`,
  `shadow-card`) используются вместо разбросанных `gray-*`/`indigo-*` —
  прямые `gray-*` в шаблонах исчезают (кроме сознательных исключений).
- Все страницы из §4.2 проходят визуальный чек-лист: desktop ≥1280px и
  мобильный ~390px без горизонтального скролла и «прилипших» элементов.
- Фокус-обводки видны при Tab-навигации; контраст текста ≥ WCAG AA на
  основных парах (zinc-900/white, white/indigo-600).
- Обложки выровнены по `aspect-[2/3]`; без обложки — единый плейсхолдер.
- `bun test` (web unit + полный прогон) зелёный — функционал не тронут;
  `bun run lint` чист.

## 7. Test plan

- Функциональных изменений нет — существующие `*.spec.ts` в `apps/web`
  остаются критерием регресса (не правим под новую разметку, если только
  тест не привязан к конкретному class — такие правки помечаются в PR).
- Визуальная приёмка — ручной чек-лист по §6 (демо-стек `bun run apps:up`
  или локальный dev + `infra:up`).

## 8. NFR / риски

- Порядок относительно 08: независимы; при выкате 09 раньше — `BookCover`
  даёт плейсхолдер, 08 добавляет upload/`@error`; при выкате 08 раньше —
  09 доводит плейсхолдер до дизайна. Конфликтов по файлам минимум
  (`BookCard`, `BookFormModal`, `books/[id]` — ребейз решает тривиально).
- Новая зависимость одна (fontsource). Tailwind остаётся v3 —
  `@nuxtjs/tailwindcss` 6.x; переезд на v4 — отдельная тема.
- SSR/гидрация: стили статические, flash-of-unstyled исключён (cssPath
  тот же).
