# Book Shop

Fullstack book shop — educational microservices showcase. **Bun workspaces**
monorepo: NestJS backend services talking **gRPC** (sync) and **Kafka** (domain
events), PostgreSQL per service, Redis for the cart, and a **Nuxt** (Vue SSR)
frontend behind a REST api-gateway.

> Status: foundation scaffold. Services are implemented one per plan via the
> spec-driven workflow — see [AGENTS.md](AGENTS.md).

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

- [Bun](https://bun.sh)
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
