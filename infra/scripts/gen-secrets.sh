#!/usr/bin/env bash
# Generates the dev JWT Ed25519 key pair via apps/auth-service's `gen-keys`
# script and writes the BASE64-ENCODED PEM values into infra/secrets/ as
# docker-secrets files (infra/docker-compose.yml mounts them at
# /run/secrets/jwt_private|jwt_public).
#
# resolveSecret() returns file content as-is and the apps base64-decode it
# themselves (tokens.ts / jwt-verifier.ts), so the files must hold the
# base64 strings printed by gen-keys — NOT the raw PEM.
#
# Dev-only convenience (AGENTS.md: infra secrets are local-only, never
# reused in production). Re-run anytime to rotate — outstanding JWTs are
# invalidated. Run from anywhere: `bun run infra:secrets`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_DIR="${REPO_ROOT}/infra/secrets"
mkdir -p "${SECRETS_DIR}"

output="$(cd "${REPO_ROOT}/apps/auth-service" && bun run gen-keys)"

private_key="$(printf '%s\n' "${output}" | sed -n 's/^JWT_PRIVATE_KEY=//p' | head -n1)"
public_key="$(printf '%s\n' "${output}" | sed -n 's/^JWT_PUBLIC_KEY=//p' | head -n1)"

if [ -z "${private_key}" ] || [ -z "${public_key}" ]; then
  echo "gen-secrets: gen-keys output is missing JWT_PRIVATE_KEY/JWT_PUBLIC_KEY" >&2
  echo "${output}" >&2
  exit 1
fi

printf '%s\n' "${private_key}" > "${SECRETS_DIR}/jwt_private.pem"
printf '%s\n' "${public_key}" > "${SECRETS_DIR}/jwt_public.pem"
chmod 600 "${SECRETS_DIR}/jwt_private.pem" "${SECRETS_DIR}/jwt_public.pem"

echo "gen-secrets: wrote ${SECRETS_DIR}/jwt_private.pem and jwt_public.pem (chmod 600)"
