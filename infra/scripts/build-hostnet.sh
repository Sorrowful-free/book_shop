#!/usr/bin/env bash
# Builds the six app images with --network=host — workaround for hosts where
# containers can't reach external DNS from bridge networks (VPN/firewall
# dropping outbound UDP:53). `bun install` inside the Dockerfile needs the
# network; runtime does not (compose service discovery uses the embedded
# resolver, so a plain `docker compose --profile apps up -d` works after).
#
# Why not `docker compose -f docker-compose.yml -f hostnet.yml build`:
# compose delegates to buildx bake, which requires the
# `--allow=network.host` entitlement — and `docker compose build` has no
# flag to pass it. Plain `docker build --network=host` works directly.
#
# Image tags must match what compose computes for the project dir
# (`infra-<service>`), otherwise `up` will try to build again.
# Run from anywhere: `bun run apps:build:hostnet`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

build() {
  local tag="$1" dockerfile="$2"
  shift 2
  echo "[build-hostnet] ${tag}"
  docker build --network=host -t "infra-${tag}" -f "${dockerfile}" "$@" .
}

build auth-service    infra/docker/Dockerfile.service \
  --build-arg APP=auth-service \
  --build-arg PRISMA_SCHEMA=apps/auth-service/prisma/schema.prisma
build catalog-service infra/docker/Dockerfile.service \
  --build-arg APP=catalog-service \
  --build-arg PRISMA_SCHEMA=apps/catalog-service/prisma/schema.prisma
build order-service   infra/docker/Dockerfile.service \
  --build-arg APP=order-service \
  --build-arg PRISMA_SCHEMA=apps/order-service/prisma/schema.prisma
build cart-service    infra/docker/Dockerfile.service \
  --build-arg APP=cart-service
build api-gateway     infra/docker/Dockerfile.service \
  --build-arg APP=api-gateway
build web             infra/docker/Dockerfile.web

echo "[build-hostnet] done — start with: docker compose -f infra/docker-compose.yml --profile apps up -d"
