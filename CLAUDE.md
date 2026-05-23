# apex-server — Claude Code Guide

**Package:** `@qt-test/apex-server` | **Version:** 0.18.1  
**Role:** Package registry and distribution backend. Handles developer auth, `.map` package uploads, signing, versioning, and delivery to native host apps.

---

## What this package does

- REST API for the APEX mini-app registry
- Developer account management (register, login, JWT auth)
- `.map` package upload, validation, registry counter-signing, and versioning
- Package download endpoint consumed by native host apps
- Swagger UI at `/documentation`

**Deployed on:** Railway.app at `https://apex-registry-production.up.railway.app`

---

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | `createServer()` / `startServer()` exports, service re-exports |
| `src/cli.ts` | Server startup entry point |
| `src/services/auth.ts` | Register, login, JWT generation |
| `src/services/apps.ts` | App CRUD, package upload handling |
| `src/services/versions.ts` | Version management, semver validation |
| `src/db/schema.ts` | Drizzle ORM schema (PostgreSQL) |
| `src/db/migrate.ts` | Migration runner |
| `src/db/seed.ts` | Initial seed data |
| `src/db/promote-admin.ts` | Promote user to admin |
| `bin/server.js` | Binary entry point |

---

## Tech stack

| Component | Technology |
|-----------|-----------|
| Framework | Fastify v4 |
| Database | PostgreSQL via `postgres` npm package + Drizzle ORM |
| Auth | @fastify/jwt + bcrypt |
| Validation | Zod schemas |
| Logging | Pino + pino-pretty |
| File uploads | @fastify/multipart |
| Rate limiting | @fastify/rate-limit |
| API docs | @fastify/swagger + swagger-ui |
| Package handling | adm-zip |

---

## Environment variables

Copy `.env.example` to `.env` before running locally:

```bash
HOST=0.0.0.0
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/apex
JWT_SECRET=<strong random secret>
JWT_EXPIRES_IN=7d
STORAGE_PATH=./data/packages
MAX_PACKAGE_SIZE=52428800    # 50MB
RATE_LIMIT=100
RATE_LIMIT_WINDOW=60000
CORS_ORIGINS=*
LOG_LEVEL=info
```

**Never commit a real `JWT_SECRET` to source control.**

On Railway, `DATABASE_URL` is injected automatically when you add a PostgreSQL service and link it to the server service. You do not need to set it manually there.

---

## Commands

```bash
npm install
cp .env.example .env           # first time only

npm run dev                    # tsx watch src/cli.ts (hot reload)
npm run start                  # node dist/cli.js (production)
npm run build                  # tsup → dist/

npm run db:migrate             # run pending migrations
npm run db:seed                # seed initial data (run after migrate on fresh DB)
npm run db:promote-admin       # make a user an admin (prompts for email)

npm run test
npm run test:watch
npm run test:coverage
npm run clean
npm publish                    # runs build first
```

---

## API overview

| Route | Description |
|-------|-------------|
| `POST /auth/register` | Create developer account |
| `POST /auth/login` | Get JWT token |
| `GET /apps` | List all published apps |
| `POST /apps` | Create app record |
| `GET /apps/:id` | App details |
| `POST /apps/:id/versions` | Upload new `.map` version |
| `GET /apps/:id/versions/:version/download` | Download `.map` package |
| `GET /documentation` | Swagger UI |

---

## Development rules

- All route handlers must use Zod schemas for request validation — never trust raw `req.body`.
- JWT validation is handled by `@fastify/jwt` — use `request.jwtVerify()` in protected routes, not manual token parsing.
- Package uploads: validate `.map` structure (manifest.json present, developer signature valid) before storing. Counter-sign with registry key after validation.
- File storage is local filesystem at `STORAGE_PATH`. For production, this should be abstracted to object storage (S3/R2) — keep the storage layer behind a service interface.
- Database uses PostgreSQL (via the `postgres` npm package). All Drizzle ORM queries return Promises — every DB call must be `await`ed and every function containing DB calls must be `async`.
- Migrations run automatically on startup via `runMigrations()` in `src/db/index.ts` using idempotent `CREATE TABLE IF NOT EXISTS` raw SQL. To add a new table or column, add the DDL there and redeploy — do not drop or rename existing columns without a separate cleanup pass.
- Money/balance columns are stored as `BIGINT` (kobo). Never use floating-point types for currency.
- For local development, spin up Postgres with Docker: `docker run -e POSTGRES_DB=apex -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine`

---

## Publishing checklist

1. Run DB migrations on staging, verify schema
2. `npm run test`
3. Bump version in `package.json`
4. `npm run build`
5. `npm publish`
6. Deploy to Railway (push to main branch triggers deploy)
