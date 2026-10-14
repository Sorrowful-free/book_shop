#!/usr/bin/env bash
# Shared entrypoint for the backend images (infra/docker/Dockerfile.service).
#
#   APP           workspace dir under /app/apps (baked in via build arg)
#   PRISMA_SCHEMA repo-root-relative schema path → runs
#                 `prisma migrate deploy` first (idempotent; only the
#                 committed prisma/migrations/ are applied — `migrate dev`
#                 is never used in containers)
#   RUN_SEED=1    runs `bun run db:seed` in the app dir after migrations —
#                 catalog-service only (its demo books are required by the
#                 storefront; auth seeds admin inside the app itself at
#                 bootstrap and order-service has no seed)
set -euo pipefail

if [ -z "${APP:-}" ]; then
  echo "[entrypoint] APP is not set — pass it as a build arg (e.g. auth-service)" >&2
  exit 1
fi

if [ -n "${PRISMA_SCHEMA:-}" ]; then
  echo "[entrypoint] bunx prisma migrate deploy --schema ${PRISMA_SCHEMA}"
  # --schema is resolved relative to the cwd → run from the repo root.
  # DATABASE_URL comes from the compose environment.
  (cd /app && bunx prisma migrate deploy --schema "${PRISMA_SCHEMA}")
fi

cd "/app/apps/${APP}"

if [ "${RUN_SEED:-0}" = "1" ]; then
  echo "[entrypoint] bun run db:seed (${APP})"
  bun run db:seed
fi

echo "[entrypoint] starting ${APP}"
# exec → bun becomes PID 1 so SIGTERM reaches the NestJS shutdown hooks.
exec bun run src/main.ts
