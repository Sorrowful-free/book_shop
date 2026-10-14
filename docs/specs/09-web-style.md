# 09. web-style — визуальный рефреш витрины

> Статус: implemented
> Затрагивает: `apps/web` (только стили/шаблоны; без изменений
> backend, контрактов и логики)

## 1. Ответственность и границы

Довести UI до цельного «современный e-commerce» вида: нейтральная база +
один акцент (near-black `zinc-900`, не indigo), строгая сетка, больше
воздуха, консистентные контролы. Дизайн-токены — в собственном
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
| Нейтралы | `zinc` — база для семантических алиасов ниже; в шаблонах напрямую не используется (редкие сознательные исключения допустимы) |
| Акцент | `primary` = палитра `zinc` целиком + алиас `primary`→900 (near-black; hover `primary-700`, фокус-кольцо `primary-500`) |
| Семантика | `bg-page`=`zinc-50`, `bg-surface`=`white`, `text-ink`=`zinc-900`, `text-muted`=`zinc-500`, `text-faint`=`zinc-400`, `border-line`=`zinc-200`; `success`/`warning`/`danger` = emerald/amber/red для статусов заказов и stock-бейджей |
| Шрифт | `@fontsource-variable/inter` (variable-файл, self-hosted — работает офлайн и в Docker); `fontFamily.sans` + fallback system stack |
| Радиусы | карточки `rounded-xl`, контролы `rounded-lg` |
| Тени | `shadow-card`: мягкая карточная тень; `shadow-card-hover` — приподнятая |
| Обложка | `aspect-[2/3]` (книжная пропорция) вместо фиксированных высот |

Все токены семантические — шаблоны и component-классы используют
`bg-surface`/`text-muted`/`bg-primary`/`border-line` и т.п., а не
литералы палитры. `gray-*` в шаблонах исчезает полностью; `indigo-*`
заменяется на `primary`; `zinc-*` — только сознательные исключения.
Смена палитры позже (включая dark) будет точечной.

## 3. Component-классы (`app/assets/css/main.css`)

`@layer components` с `@apply` для повторяющихся паттернов — убирает
utility-soup из шаблонов и гарантирует консистентность:

- `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost` —
  одинаковая геометрия (h-9, px-4, rounded-lg, font-medium), состояния
  hover/active/disabled/focus-visible;
- `.input` — единый стиль всех полей: `<input>`, `<select>`, `<textarea>`
  (border-line, focus ring primary);
- `.card` — `rounded-xl border border-line bg-surface shadow-card`;
- `.badge` — чипы статусов/жанра/stock (варианты через
  success/warning/danger);
- `.alert`, `.alert-danger` — блок ошибок форм/checkout (red-50 фон,
  red-700 текст, rounded-lg);
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
  `aspect-[2/3] w-24`, кнопки по §3 (upload-виджет из 08 стилизуется
  теми же классами — функционал не трогаем).
- **Новый `BookCover`** (общий): `<img>` + `@error`-фолбэк + плейсхолдер —
  нейтральный градиент (`zinc-100→zinc-200`) с инициалами: до двух
  заглавных букв от первых слов `title` («The Hobbit» → «TH»), при пустом
  title — инициалы `author`, при пустых обоих — чистый градиент.
  Props: `coverUrl`, `title`, `author` + `class` для размера;
  `aspect-[2/3]` внутри компонента. Используется в `BookCard`,
  `books/[id]`, `cart`, превью формы. 08 уже смержена — компонент
  консолидирует три продублированных `@error`-фолбэка (`coverOk`-логика
  уезжает внутрь `BookCover`).

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
- loading-скелет витрины — `animate-pulse` поверх текущего приглушения
  (подтверждено).

## 5. Зависимости

- `bun add @fontsource-variable/inter` (variable-файл — выбрано) —
  единственная новая зависимость; `@import '@fontsource-variable/inter'`
  первой строкой `main.css` + `fontFamily.sans` в конфиге.
- Никаких UI-библиотек, иконки — простые unicode/inline-SVG при
  необходимости (без иконочных пакетов).

## 6. Acceptance criteria

- `tailwind.config.ts` создан; семантические токены (`primary`,
  `surface`, `page`, `ink`/`muted`/`faint`, `line`, `shadow-card`)
  используются вместо разбросанных `gray-*`/`indigo-*` — прямые `gray-*`
  в шаблонах исчезают полностью, `zinc-*`/`indigo-*` — только
  сознательные исключения.
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

- 08 уже смержена: `BookCover` консолидирует существующие
  `@error`-фолбэки (`BookCard`, `BookFormModal`, `books/[id]`) и доводит
  плейсхолдер до дизайна. Функционал upload-виджета не трогаем — только
  классы.
- Новая зависимость одна (fontsource). Tailwind остаётся v3 —
  `@nuxtjs/tailwindcss` 6.x; переезд на v4 — отдельная тема.
- SSR/гидрация: стили статические, flash-of-unstyled исключён (cssPath
  тот же).
