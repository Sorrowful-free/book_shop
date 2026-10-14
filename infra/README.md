# infra

Local development dependencies. Everything is started with:

```bash
bun run infra:up      # up -d
bun run infra:ps      # status
bun run infra:logs    # follow logs
bun run infra:down    # stop
```

## Services

| Service    | Endpoint (host)        | Notes                                            |
| ---------- | ---------------------- | ------------------------------------------------ |
| PostgreSQL | `localhost:5432`       | `postgres`/`postgres`; init creates `auth_db` (auth_user), `catalog_db` (catalog_user), `order_db` (order_user) — passwords match `*_user` names with `_pass` suffix |
| Redis      | `localhost:6379`       | cart-service storage + shared JWT denylist `auth:revoked:*` (written by auth, read by all services) |
| Kafka      | `localhost:29092`      | external listener for apps running on the host   |
| Kafka      | `kafka:9092`           | internal listener for container-to-container     |
| Kafka UI   | `http://localhost:8085`| topic/message browser                            |

Databases are per-service (`auth`, `catalog`, `order`) on a single PostgreSQL
instance — logical database-per-service. Re-run `init/*.sql` from scratch by
removing the `postgres-data` volume.

## Full stack (`apps` profile)

The same `docker-compose.yml` also runs the six apps — 4 gRPC services,
api-gateway and the Nuxt web frontend — under the `apps` profile
(spec `docs/specs/07-docker.md`):

```bash
bun run infra:secrets   # one-time: JWT keypair → secrets/*.pem (gitignored)
bun run apps:up         # build images + up -d (infra starts too — it's a dependency)
bun run apps:logs       # follow logs
bun run apps:down       # stop EVERYTHING (apps + infra — `down` covers the
                        # profile-less infra services as well)
```

- `infra/secrets/` must exist before `apps:up` — compose fails on missing
  secret files. `gen-secrets.sh` runs `bun run gen-keys` in
  `apps/auth-service` and writes the base64-PEM values to
  `secrets/jwt_private.pem` + `secrets/jwt_public.pem` (chmod 600).
  `jwt_private` is mounted only into auth-service; `jwt_public` into every
  JWT-verifying service. Re-run to rotate — outstanding JWTs die.
- Endpoints: web `http://localhost:3001`, api-gateway
  `http://localhost:3000` (swagger `/api/docs`), kafka-ui `:8085`. gRPC
  ports 50051–50054 are internal-only, reachable by compose DNS name.
- Demo accounts: `admin`/`admin` (seeded by auth-service; optional employer
  via `SEED_EMPLOYER_*` env). catalog-service runs its idempotent book seed
  on every start (`RUN_SEED=1` in the entrypoint).
- Schema caveat: containers run `prisma migrate deploy` against committed
  `prisma/migrations/` only. If a dev branch ever left schema drift on the
  `postgres-data` volume, reset with
  `docker compose -f infra/docker-compose.yml --profile apps down -v`
  (drops postgres/redis/kafka data — registered users and carts are lost).
- Broken container DNS (VPN/firewall dropping outbound UDP:53 from bridge
  networks): `bun install` inside `docker build` fails with
  `DNSResolveFailed`. Build the images with host networking, then `up`
  normally — runtime is unaffected (compose service discovery uses the
  embedded resolver):

  ```bash
  bun run apps:build:hostnet   # infra/scripts/build-hostnet.sh
  docker compose -f infra/docker-compose.yml --profile apps up -d
  ```

  (`docker compose build` can't do this itself: it delegates to buildx
  bake, which wants a `--allow=network.host` entitlement compose won't
  pass — the script uses plain `docker build --network=host`.)
