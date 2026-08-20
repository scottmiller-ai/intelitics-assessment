# Intelitics usage billing assessment

A Node 22/TypeScript service that normalizes usage events into Postgres and
answers tenant-scoped billing usage questions through Fastify.

## Reviewer setup

Prerequisites: Node 22 LTS, Corepack, and a running Docker daemon with Compose.

```sh
corepack enable
pnpm bootstrap
```

`bootstrap` installs the locked dependencies, creates `.env` if needed, starts
Postgres, bootstraps roles and RLS, applies migrations, and ingests the fixture.
Before making changes it verifies the required tools, Docker daemon, Postgres
port `5432`, and configured database environment. Postgres conflicts fail with
commands to identify the listener. It is safe to run again; an
already-successful source is skipped.

Start the API on `127.0.0.1:3000`:

```sh
pnpm dev
```

If local infrastructure is not running, use the explicitly mutating shortcut:

```sh
pnpm dev:up
```

The API port is configurable with `PORT` in `.env`. `predev` checks that the
configured address is available and reports how to identify a conflicting
listener before Fastify starts.

## Verification

Run the complete isolated acceptance workflow:

```sh
pnpm verify
```

This runs formatting, linting, strict typechecking, build, and unit tests; then
starts a disposable Testcontainers Postgres, verifies initial and duplicate
ingestion, starts the built API, compares complete golden responses and errors,
and runs the serial integration and database-role isolation suite.

Integration tests also create a disposable database by default, even when
application URLs exist in `.env`. The acceptance runner can explicitly reuse
its container only when every role URL targets the same database whose name
ends in `_test`.

Individual checks:

```sh
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test
pnpm start
```

`pnpm start` runs the previously compiled `dist/api/server.js`; run
`pnpm build` first.

## Golden requests

All billing windows are UTC half-open intervals `[from, to)`.

```sh
curl -sS \
  -H 'X-Customer-Id: cust_006' \
  'http://127.0.0.1:3000/customers/cust_006/usage?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z'

curl -sS \
  -H 'X-Customer-Id: cust_006' \
  'http://127.0.0.1:3000/customers/cust_006/usage/endpoints?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z'

curl -sS \
  -H 'X-Customer-Id: cust_006' \
  'http://127.0.0.1:3000/customers/cust_006/usage/users?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z'

curl -sS \
  -H 'X-Admin: true' \
  'http://127.0.0.1:3000/usage/top-customers?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z&limit=10'
```

The headers are local authentication adapters. They are not production
authentication.

## Manual database and ingest workflow

The expanded commands are useful when debugging bootstrap:

```sh
docker compose up -d --wait postgres
cp -n .env.example .env
pnpm db:bootstrap
pnpm db:migrate
pnpm ingest -- data/fixtures/usage_events.json
```

The first fixture ingest reports `417 accepted / 16 duplicate / 9 rejected`.
An identical source is skipped by its content hash.

## Teardown

Normal teardown removes containers, volumes, and generated artifacts while
preserving dependencies and local environment configuration:

```sh
pnpm teardown
```

Full teardown additionally removes `.env` and `node_modules`:

```sh
pnpm teardown -- --full
```

Blank-slate regression:

```sh
pnpm teardown -- --full
corepack enable
pnpm bootstrap
pnpm verify
```
