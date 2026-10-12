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
| Redis      | `localhost:6379`       | cart-service storage                             |
| Kafka      | `localhost:29092`      | external listener for apps running on the host   |
| Kafka      | `kafka:9092`           | internal listener for container-to-container     |
| Kafka UI   | `http://localhost:8085`| topic/message browser                            |

Databases are per-service (`auth`, `catalog`, `order`) on a single PostgreSQL
instance — logical database-per-service. Re-run `init/*.sql` from scratch by
removing the `postgres-data` volume.
