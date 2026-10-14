# Implementer subagent prompt — шаблон

Скелет промпта для сабагента, реализующего сервис/фичу по спеке.
Заполнить слоты `[...]`, остальное — boilerplate.

## Background-агент (exec недоступен)

```
Implement [apps/<name>] in the Bun monorepo at /home/user/Repositories/book_shop.

ENVIRONMENT (background agent):
- exec is FULLY unavailable: no bun/node/npx/eslint/tsc/mkdir — do not probe.
- The `write` tool creates parent directories implicitly; no mkdir needed.
- Deps: hand-edit package.json (never bun.lock) and FLAG it in your report —
  the parent runs `bun install`.
- Do NOT polish formatting — the parent runs `eslint --fix` after you.
- You cannot verify anything; the parent runs lint/typecheck/tests.

FIRST read in order — they are the contract for your work:
1. AGENTS.md (repo root) — hard rules (portability, @Ctx(), rpcError,
   resolveSecret, no mock.module, never commit).
2. docs/specs/NN-<name>.md — THE SPEC.
3. docs/specs/fixes/<name>.md — F-* amendments overriding the spec. [if any]

REFERENCE IMPLEMENTATION — mimic structure/style: [apps/<sibling>] —
read its [app.module.ts, main.ts, repository, dto, test/, package.json,
prisma/schema.prisma].

OWNERSHIP: you own [apps/<name>/ + list]. Do NOT modify [other dirs] —
other agents own them concurrently. packages/contracts is already updated —
only read it.

REPORT MUST STATE: files created, deviations from spec, hand-edited
package.json, anything you could not verify.
```

## Foreground-агент (exec доступен)

Тот же скелет, но блок ENVIRONMENT заменить на:

```
VERIFY before reporting: bun install (if you added deps), bun run lint,
bun --filter '<pkg>' typecheck, bun test <app path>. Report what you ran
and the results.
```

## Заметки для оркестратора

- Background = код без verify-цикла; назначай его только на мелкие
  изолированные правки. Основной артефакт — foreground (см. DEFERRED G4).
- Родитель обязан прогнать после каждой background-волны:
  `bun install` → `bun run lint` (с --fix) → `bun run typecheck` →
  `bun run test:unit` → e2e на поднятой инфре.

## Уроки из ревью (добавлять в промпт при повторении класса ошибки)

- Acceptance-критерии спеки — буквальны: коды статусов, строки, лимиты
  реализуются и ассертятся дословно (08 поймал 201-vs-200 на
  `POST /covers/upload`).
- Литерал (regex, mime-лист, path-префикс), нужный по обе стороны
  сервисной границы, живёт в `@book-shop/contracts` — иначе 4 копии
  в расходятся (08: cover key/mime в catalog+gateway+web+proto-комменте).
- Review-дифф для read-only агентов: `git add -N` на untracked-файлы +
  `git diff HEAD > .scratch/review.diff` (каталог в .gitignore), передать
  путь — надёжнее встраивания диффа в промпт. `add -N` ставит только
  intent-to-add, безопасно для чужого дерева.
