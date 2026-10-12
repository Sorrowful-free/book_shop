# Book Shop Backend

REST API for a book shop built with [NestJS](https://nestjs.com) running on the [Bun](https://bun.sh) runtime.

Features:

- Books CRUD with pagination
- Orders with Redis-backed temporary storage (cart) and checkout to MongoDB
- JWT authentication (access + refresh tokens) with role-based access control
- MongoDB persistence via Mongoose

## Tech stack

- **NestJS 11** + Express 5
- **Bun** — runtime, package manager and test runner
- **MongoDB** via `@nestjs/mongoose` (mongoose 8)
- **Redis** via `@nestjs-modules/ioredis`
- **Passport** — local + JWT strategies
- `class-validator` DTO validation

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Docker + Docker Compose (for MongoDB/Redis, or the whole stack)

## Installation

```bash
bun install
```

## Configuration

Environment variables are loaded from the file pointed to by `NODE_ENV_FILE`:

- `env/debug.env` — local development (`localhost` endpoints)
- `env/prod.env` — containers (docker-compose service names)

| Variable | Description |
| --- | --- |
| `MONGOOSE_URL` | MongoDB connection URL |
| `REDIS_URL` | Redis connection URL |
| `REDIS_EXPIRE_IN` | Order TTL in Redis (seconds) |
| `JWT_TOKEN_SECRET` | Secret for signing JWTs |
| `JWT_ACCESS_TOKEN_EXPIRES_IN` | Access token TTL (seconds) |
| `JWT_REFRESH_TOKEN_EXPIRES_IN` | Refresh token TTL (seconds) |

## Running the app

Start MongoDB and Redis first:

```bash
docker compose up -d mongo redis
```

Then:

```bash
# development (build + run compiled output via bun)
bun run start

# watch mode
bun run start:dev

# debug mode (bun inspector, runs TypeScript directly)
bun run start:debug

# production (requires `bun run build` first)
bun run start:prod
```

The API listens on `http://localhost:3000`.

### All-in-one with Docker Compose

```bash
docker compose up --build
```

Builds the backend on the `oven/bun` image and starts it together with MongoDB and Redis.

## Test

```bash
# unit / e2e tests (bun test)
bun run test

# watch mode
bun run test:watch

# test coverage
bun run test:cov
```

Note: the e2e spec boots the whole `AppModule`, so MongoDB and Redis must be running (`docker compose up -d mongo redis`).

## API overview

| Method | Route | Description | Roles |
| --- | --- | --- | --- |
| POST | `/auth/login` | Login, returns access + refresh tokens | public |
| POST | `/auth/refresh` | Refresh access token | any authenticated |
| GET | `/user` | Current user name | public |
| GET | `/book` | List books (`index`, `count` in body) | public |
| GET | `/book/findById` | Find book by `book_id` | public |
| GET | `/book/findByName` | Find book by `book_name` | public |
| POST | `/book/create` | Create a book | Employer, Admin |
| PATCH | `/book/update` | Update a book | Employer, Admin |
| DELETE | `/book/delete` | Delete a book | Admin |
| GET | `/order` | Current user's stored order | Customer, Employer, Admin |
| GET | `/order/:id` | Find an order | Customer, Employer, Admin |
| POST | `/order` | Store order in Redis (cart) | Customer, Employer, Admin |
| POST | `/order/checkout` | Persist order to MongoDB | Customer, Employer, Admin |
| DELETE | `/order/delete/:id` | Delete an order | Employer, Admin |

## Demo users

Seeded in `DatabaseService` (in-memory, for demo purposes):

| user_name | password | role |
| --- | --- | --- |
| `admin` | `admin` | Admin |
| `vitek` | `super_puper_pass` | Employer |
| `vasya` | `super_puper_pass` | Customer |

Login example:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"login": "admin", "password": "admin"}'
```

## Scripts

```bash
bun run build    # nest build -> dist/
bun run lint     # eslint --fix
bun run format   # prettier --write
```

## License

UNLICENSED
