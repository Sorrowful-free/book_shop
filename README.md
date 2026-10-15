# Book Shop

Fullstack book shop — educational microservices showcase. **Bun workspaces**
monorepo: NestJS backend services talking **gRPC** (sync) and **Kafka** (domain
events), PostgreSQL per service, Redis for the cart, and a **Nuxt** (Vue SSR)
frontend behind a REST api-gateway.

> Status: all services implemented (specs 01–09). Built via the spec-driven
> workflow — see [AGENTS.md](AGENTS.md).

## Development timeline

An example of a **time-to-market** strategy: the repository was originally
prototyped in late 2022 (a single-service app, dormant for ~4 years), then
rebuilt from scratch as a microservices monorepo. The full rebuild — four
gRPC services, api-gateway, Nuxt SSR web app, Kafka transactional outbox,
Docker stack — was delivered in **3 calendar days (12–14 Oct 2026, ~56
hours elapsed), 29 commits**, starting from `79727a2`
(`git log --oneline 79727a2~..HEAD`).

| Commit    | Date   | Milestone                                                |
| --------- | ------ | -------------------------------------------------------- |
| `79727a2` | 12 Oct | rebuild kickoff — npm→Bun migration, monorepo pivot      |
| `1086b4d` | 12 Oct | auth-service + workspace scaffold (spec 01)              |
| `5e515ac` | 12 Oct | catalog + cart services, Prisma migrations (specs 02–03) |
| `3022b9b` | 13 Oct | order-service — checkout saga (spec 04)                  |
| `daa516f` | 13 Oct | api-gateway — REST→gRPC, JWT, BFF (spec 05)              |
| `bac3579` | 13 Oct | web — Nuxt SSR storefront (spec 06)                      |
| `715ba7a` | 14 Oct | Docker — full-stack compose (spec 07)                    |
| `51e62f6` | 14 Oct | book covers — MinIO presigned uploads (spec 08)          |
| `dfbf60a` | 14 Oct | design system — web visual refresh (spec 09)             |

## Architecture

```
        Nuxt web (SSR)                      HTTP
            │                                 │
            ▼                                 ▼
      api-gateway :3000  ── gRPC + metadata ──┐
        (JWT verify, roles)                   │
   ┌──────────┬──────────┬──────────┐         │
   ▼          ▼          ▼          ▼         │
 auth :50051  catalog    cart       order ◄───┘
             :50052      :50053     :50054
   │          │          │          │
 Postgres   Postgres   Redis     Postgres
 auth_db    catalog_db           order_db
   └──────────┴── Kafka events ───┘
```

## Repository layout

| Path                 | Contents                                                        |
| -------------------- | --------------------------------------------------------------- |
| `apps/`              | Deployable apps (see `apps/README.md` for the roadmap table)     |
| `packages/contracts` | `*.proto`, Kafka topics, event payloads, shared types            |
| `packages/common`    | gRPC metadata user-context helpers, roles                        |
| `infra/`             | docker-compose: PostgreSQL, Redis, Kafka (KRaft), Kafka UI       |
| `docs/specs/`        | Service specs (`_template.md`)                                   |

## Prerequisites

- [Bun](https://bun.sh) — dev toolchain (install, test, scripts). Application
  code is runtime-agnostic and must also run under Node.js LTS — no
  `Bun.*`/`bun:*` outside tests (enforced by eslint, see AGENTS.md)
- Docker + Docker Compose
- `buf` CLI (optional, for proto lint)

## Quick start

```bash
bun install          # install all workspaces
bun run infra:up     # postgres + redis + kafka + kafka-ui (:8085)
bun test             # all tests
bun run lint         # eslint
bun run typecheck    # tsc --noEmit per workspace
```

## Run with Docker

The whole stack — infra plus all six apps — runs in Docker; no local
services needed (spec: `docs/specs/07-docker.md`). Bun on the host is only
used once to generate the dev JWT keypair (`apps/auth-service`'s
`gen-keys`, needs `bun install` first):

```bash
bun run infra:secrets   # one-time: JWT keypair → infra/secrets/*.pem (gitignored)
bun run apps:up         # docker compose --profile apps up -d --build
bun run apps:logs       # follow logs
bun run apps:down       # stop the whole stack — `down` also covers the
                        # profile-less infra services, so this stops
                        # postgres/redis/kafka too
```

Then open `http://localhost:3001` (storefront), `http://localhost:3000`
(api-gateway, swagger at `/api/docs`), `http://localhost:8085` (kafka-ui).
The gRPC ports are internal-only. Seeded credentials: `admin` / `admin`
(ADMIN role); the catalog starts with demo books.

`bun run infra:up` (no `--profile`) still starts only the infra services —
local development workflow is unchanged. See `infra/README.md` for the
secrets/migrations details.

## Development workflow

Each service is built in its own plan/subagent, spec-first:

1. spec in `docs/specs/NN-<service>.md` (from `_template.md`)
2. contracts in `packages/contracts` (proto, topics, events)
3. failing tests
4. implementation

Details and conventions: [AGENTS.md](AGENTS.md), infra endpoints:
[infra/README.md](infra/README.md).

## License

UNLICENSED
